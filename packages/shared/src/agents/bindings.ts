/**
 * Agent × Workspace Session Bindings
 *
 * A binding records which canonical session currently materializes a given
 * AgentProfile inside a workspace. Bindings are stored per-agent at
 * {workspaceRootPath}/.craft-agent/agent-sessions/{agentId}.json
 *
 * State machine (implementation baseline — supersedes earlier 'active'):
 *   bound    → session exists and is the canonical materialization
 *   unbound  → no canonical session (agent unbound or session deleted)
 *   conflict → explicit conflict — ensureAgentSession refuses to auto-resolve
 *
 * Generation increments every time a new canonical session replaces the
 * previous one; 'unbound' preserves the last published generation so the
 * next materialization is deterministic (N+1). The materialized session
 * carries the same generation as `agentBindingGeneration` — the binding
 * validates this on reuse, so a stale/mismatched session is never silently
 * adopted.
 *
 * Session lifecycle contract:
 * - bound + canonical session missing or mismatched → AGENT_SESSION_UNAVAILABLE.
 *   The binding is NOT modified; recovery is manual, or via deleteSession's
 *   unbind hook — never a silent rebuild.
 *
 * NOTE: bindings intentionally never call retireAgent/restoreAgent — retiring
 * or restoring an agent leaves all bindings untouched (they only take effect
 * on the next ensureAgentSession).
 */

import { existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
// NOTE: circular import with ../sessions/storage.ts is safe — createSession /
// loadSession are only accessed inside function bodies, never at module
// initialization time (same pattern as workspaces/storage ↔ migrate-namespace).
import { createSession, loadSession } from '../sessions/storage.ts';
import { readSessionHeader } from '../sessions/jsonl.ts';
import { getAgent, loadLatestRevision, resolveAgentSnapshot } from './storage.ts';
import { WORKSPACE_NAMESPACE, getWorkspaceSessionsPath } from '../workspaces/storage.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { debug } from '../utils/debug.ts';
import type { SessionConfig } from '../sessions/types.ts';

const BINDING_SCHEMA_VERSION = 1 as const;

// ============================================================
// Errors
// ============================================================

export type AgentSessionError =
  | 'AGENT_NOT_FOUND'
  | 'AGENT_RETIRED'
  | 'AGENT_BINDING_CONFLICT'
  | 'AGENT_SESSION_UNAVAILABLE'
  | 'AGENT_EXECUTION_UNAVAILABLE';

export class AgentSessionBindingError extends Error {
  constructor(public code: AgentSessionError, message: string) {
    super(message);
    this.name = 'AgentSessionBindingError';
  }
}

// ============================================================
// Types
// ============================================================

/**
 * Binding between an AgentProfile and the canonical session that
 * materializes it inside a workspace.
 */
export type AgentSessionBindingState = 'bound' | 'unbound' | 'conflict';

export interface AgentSessionBinding {
  schemaVersion: 1;
  workspaceId: string;
  agentId: string;
  state: AgentSessionBindingState;
  /** Present only when state === 'bound' */
  canonicalSessionId?: string;
  /** Last published generation; preserved across unbound (never reset) */
  generation: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Binding enriched with the canonical session's profile revision
 * (diagnostics-only, Issue #15 — never used for identity or dispatch).
 */
export interface AgentBindingDiagnostics extends AgentSessionBinding {
  /** Profile revision of the bound canonical session; undefined when unbound or session unreadable. */
  sessionProfileRevision?: number;
}

// ============================================================
// Storage (per-agent files)
// ============================================================

export function getBindingPath(workspaceRootPath: string, agentId: string): string {
  return join(workspaceRootPath, WORKSPACE_NAMESPACE, 'agent-sessions', `${agentId}.json`);
}

/**
 * Load the binding for one agent. Returns null when missing or unreadable
 * (corrupt files are logged and treated as absent).
 */
export function loadBinding(
  workspaceRootPath: string,
  agentId: string
): AgentSessionBinding | null {
  const path = getBindingPath(workspaceRootPath, agentId);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const binding = readJsonFileSync<AgentSessionBinding>(path);
    if (!binding || typeof binding !== 'object' || binding.agentId !== agentId) {
      debug(`[bindings] binding file at ${path} has invalid shape, treating as absent`);
      return null;
    }
    return binding;
  } catch (err) {
    debug(
      `[bindings] failed to read binding at ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Persist a binding (atomic write, per-agent file).
 */
export function saveBinding(workspaceRootPath: string, binding: AgentSessionBinding): void {
  const dir = join(workspaceRootPath, WORKSPACE_NAMESPACE, 'agent-sessions');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  atomicWriteFileSync(
    getBindingPath(workspaceRootPath, binding.agentId),
    JSON.stringify(binding, null, 2)
  );
}

/**
 * List all bindings for a workspace (aggregates the per-agent files).
 * Corrupt/unreadable files are skipped.
 */
export function listBindings(workspaceRootPath: string): AgentSessionBinding[] {
  const dir = join(workspaceRootPath, WORKSPACE_NAMESPACE, 'agent-sessions');
  if (!existsSync(dir)) {
    return [];
  }
  const bindings: AgentSessionBinding[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const binding = readJsonFileSync<AgentSessionBinding>(join(dir, entry.name));
      if (binding && typeof binding === 'object' && typeof binding.agentId === 'string') {
        bindings.push(binding);
      }
    } catch {
      // skip corrupt per-agent files
    }
  }
  return bindings;
}

// ============================================================
// Queries
// ============================================================

/**
 * Get the binding for an agent, or null when none exists.
 */
export function getBinding(
  workspaceRootPath: string,
  agentId: string
): AgentSessionBinding | null {
  return loadBinding(workspaceRootPath, agentId);
}

/**
 * Resolve the current binding state for an agent without creating anything.
 * Never triggers a transition — stale bound bindings (session deleted) are
 * returned as-is; only ensureAgentSession and unbindBySessionId transition.
 */
export function resolveBinding(
  workspaceRootPath: string,
  agentId: string
): AgentSessionBinding | null {
  return getBinding(workspaceRootPath, agentId);
}

// ============================================================
// Keyed mutex (single-process authoritative server contract)
// ============================================================

const bindingLocks = new Map<string, Promise<unknown>>();

/**
 * Serialize binding transitions per (workspace, agent). Standard promise-chain
 * mutex: callers queue on the previous holder's tail; the lock entry is
 * removed once the tail settles and no further waiter has chained onto it.
 */
export async function withBindingLock<T>(
  workspaceRootPath: string,
  agentId: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = `${workspaceRootPath}::${agentId}`;
  const previous = bindingLocks.get(key) ?? Promise.resolve();
  const tail = previous.then(fn, fn);
  bindingLocks.set(key, tail);
  const cleanup = () => {
    if (bindingLocks.get(key) === tail) {
      bindingLocks.delete(key);
    }
  };
  void tail.then(cleanup, cleanup);
  return tail;
}

// ============================================================
// Crash recovery (orphan candidate scan)
// ============================================================

/**
 * Crash-recovery scan (baseline step 5: "first recover a unique complete
 * Session candidate claiming generation N+1"). createSession persists the
 * session BEFORE the binding is published (step 6 before step 7) — a crash in
 * that window leaves an orphan session on disk with no published binding.
 * Header-only scan (cheap): only complete candidates count — same agentId,
 * valid snapshot, exact target generation.
 */
function findOrphanSessionCandidates(
  workspaceRootPath: string,
  agentId: string,
  targetGeneration: number
): string[] {
  const sessionsDir = getWorkspaceSessionsPath(workspaceRootPath);
  if (!existsSync(sessionsDir)) return [];
  const candidates: string[] = [];
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const header = readSessionHeader(join(sessionsDir, entry.name, 'session.jsonl'));
    if (
      header &&
      header.agentId === agentId &&
      header.agentProfileSnapshot !== undefined &&
      header.agentBindingGeneration === targetGeneration
    ) {
      candidates.push(entry.name);
    }
  }
  return candidates;
}

// ============================================================
// Ensure / Unbind
// ============================================================

/**
 * Ensure an agent has a canonical session in the workspace, materializing one
 * from the agent's latest immutable revision when needed.
 *
 * Seven-step atomic protocol (implementation baseline):
 *   1. Agent admission (AGENT_NOT_FOUND / AGENT_RETIRED — outside the lock).
 *   2. conflict binding → AGENT_BINDING_CONFLICT (never auto-resolved).
 *   3. bound binding → validate the referenced session (same agentId AND
 *      agentBindingGeneration === binding.generation) and reuse it. Missing
 *      or mismatched → AGENT_SESSION_UNAVAILABLE, binding left untouched.
 *   4. No binding file → atomically materialize 'unbound', generation 0.
 *   5. unbound gen N → first recover a unique complete orphan session
 *      claiming generation N+1 (crash between step 6 and 7); ambiguous
 *      orphans (more than one) → AGENT_BINDING_CONFLICT. Otherwise create a
 *      fresh session with agentBindingGeneration N+1.
 *   6. (createSession persists the session before the binding is published.)
 *   7. Atomically publish 'bound' → canonicalSessionId, generation N+1.
 *
 * @throws AgentSessionBindingError for unknown/retired agents, conflict
 * bindings, missing revisions, or unavailable canonical sessions.
 */
export async function ensureAgentSession(
  workspaceRootPath: string,
  workspaceId: string,
  agentId: string
): Promise<SessionConfig> {
  // Agent admission — must exist and be active.
  const agent = getAgent(agentId);
  if (!agent) {
    throw new AgentSessionBindingError('AGENT_NOT_FOUND', `Agent not found: ${agentId}`);
  }
  if (agent.status === 'retired') {
    throw new AgentSessionBindingError('AGENT_RETIRED', `Agent is retired: ${agentId}`);
  }

  return withBindingLock(workspaceRootPath, agentId, async () => {
    const binding = loadBinding(workspaceRootPath, agentId);

    // Step 2: explicit conflict — never auto-resolve.
    if (binding?.state === 'conflict') {
      throw new AgentSessionBindingError(
        'AGENT_BINDING_CONFLICT',
        `Binding for agent ${agentId} is in conflict state; manual resolution required`
      );
    }

    // Step 3: bound — reuse only when the referenced session is intact and
    // matches this binding's generation. Anything else is an explicit
    // availability failure; the binding stays 'bound' (no silent rebuild).
    if (binding?.state === 'bound' && binding.canonicalSessionId) {
      const session = loadSession(workspaceRootPath, binding.canonicalSessionId);
      if (
        session &&
        session.agentId === agentId &&
        session.agentProfileSnapshot !== undefined &&
        session.agentBindingGeneration === binding.generation
      ) {
        return session;
      }
      // A session claiming agentId without a valid snapshot is surfaced as
      // corruption, never silently re-resolved from the latest profile (#3).
      throw new AgentSessionBindingError(
        'AGENT_SESSION_UNAVAILABLE',
        `Canonical session missing, corrupt, or mismatched for agent ${agentId}; manual resolution required`
      );
    }

    // Step 4: no binding file yet — atomically materialize 'unbound', gen 0.
    let generation = binding?.generation ?? 0;
    if (!binding) {
      const now = Date.now();
      saveBinding(workspaceRootPath, {
        schemaVersion: BINDING_SCHEMA_VERSION,
        workspaceId,
        agentId,
        state: 'unbound',
        generation: 0,
        createdAt: now,
        updatedAt: now,
      });
      generation = 0;
    }

    // Step 5: unbound gen N → materialize a new canonical session with
    // agentBindingGeneration = N+1. Crash recovery runs FIRST: a session
    // persisted by a previous run (step 6) whose binding publish (step 7)
    // never completed is recovered instead of duplicated.
    const targetGeneration = generation + 1;
    const orphanIds = findOrphanSessionCandidates(workspaceRootPath, agentId, targetGeneration);
    if (orphanIds.length > 1) {
      // Ambiguous orphans (same agent claiming the same generation) cannot be
      // auto-resolved — identical to any other conflict, manual resolution.
      throw new AgentSessionBindingError(
        'AGENT_BINDING_CONFLICT',
        `Multiple orphan sessions claim generation ${targetGeneration} for agent ${agentId}; manual resolution required`
      );
    }
    const orphanId = orphanIds.length === 1 ? orphanIds[0] : undefined;
    if (orphanId !== undefined) {
      const orphan = loadSession(workspaceRootPath, orphanId);
      if (orphan) {
        // Complete the interrupted publish: bound → orphan, generation N+1.
        const now = Date.now();
        saveBinding(workspaceRootPath, {
          schemaVersion: BINDING_SCHEMA_VERSION,
          workspaceId,
          agentId,
          state: 'bound',
          canonicalSessionId: orphan.id,
          generation: targetGeneration,
          createdAt: binding?.createdAt ?? now,
          updatedAt: now,
        });
        return orphan;
      }
      // Header readable but body corrupt — surfaced as corruption, never a
      // silent rebuild past existing data.
      throw new AgentSessionBindingError(
        'AGENT_SESSION_UNAVAILABLE',
        `Orphan session ${orphanId} for agent ${agentId} is corrupt; manual resolution required`
      );
    }

    const revision = loadLatestRevision(agentId);
    if (!revision) {
      throw new AgentSessionBindingError(
        'AGENT_SESSION_UNAVAILABLE',
        `No revision available for agent: ${agentId}`
      );
    }
    const snapshot = resolveAgentSnapshot(revision);

    const session = await createSession(workspaceRootPath, {
      agentId,
      agentProfileRevision: revision.revision,
      agentProfileSnapshot: snapshot,
      agentBindingGeneration: targetGeneration,
      permissionMode: snapshot.permissionMode,
      thinkingLevel: snapshot.thinkingLevel,
      enabledSourceSlugs: snapshot.enabledSourceSlugs,
      model: snapshot.model,
    });

    // Step 7: atomically publish 'bound' → canonicalSessionId, generation N+1.
    const now = Date.now();
    saveBinding(workspaceRootPath, {
      schemaVersion: BINDING_SCHEMA_VERSION,
      workspaceId,
      agentId,
      state: 'bound',
      canonicalSessionId: session.id,
      generation: targetGeneration,
      createdAt: binding?.createdAt ?? now,
      updatedAt: now,
    });

    return session;
  });
}

/**
 * Unbind the binding whose canonical session is `sessionId` (scans the
 * per-agent files). Best-effort: errors are logged and swallowed — never
 * throws. Generation is preserved across the unbound transition.
 */
export function unbindBySessionId(workspaceRootPath: string, sessionId: string): void {
  try {
    for (const binding of listBindings(workspaceRootPath)) {
      if (binding.state === 'bound' && binding.canonicalSessionId === sessionId) {
        saveBinding(workspaceRootPath, {
          ...binding,
          state: 'unbound',
          canonicalSessionId: undefined,
          updatedAt: Date.now(),
        });
        return;
      }
    }
  } catch (err) {
    debug(
      `[bindings] unbindBySessionId failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
