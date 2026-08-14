/**
 * Agent × Workspace Session Bindings
 *
 * A binding records which canonical session currently materializes a given
 * AgentProfile inside a workspace. Bindings are stored per-workspace at
 * {workspaceRootPath}/.craft-agent/agent-sessions/bindings.json.
 *
 * State machine:
 *   active  → session exists and is the canonical materialization
 *   unbound → no canonical session (agent unbound or session deleted)
 *   conflict→ explicit conflict — ensureAgentSession refuses to auto-resolve
 *
 * Generation increments every time a new canonical session replaces the
 * previous one, preserving session-replacement history.
 *
 * NOTE: bindings intentionally never call retireAgent/restoreAgent — retiring
 * or restoring an agent leaves all bindings untouched (they only take effect
 * on the next ensureAgentSession).
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
// NOTE: circular import with ../sessions/storage.ts is safe — createSession /
// loadSession are only accessed inside function bodies, never at module
// initialization time (same pattern as workspaces/storage ↔ migrate-namespace).
import { createSession, loadSession } from '../sessions/storage.ts';
import { getAgent, loadLatestRevision, resolveAgentSnapshot } from './storage.ts';
import { WORKSPACE_NAMESPACE } from '../workspaces/storage.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { debug } from '../utils/debug.ts';
import type { SessionConfig } from '../sessions/types.ts';

const BINDINGS_VERSION = 1;

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
export interface AgentSessionBinding {
  workspaceId: string;
  agentId: string;
  canonicalSessionId?: string;
  generation: number;
  state: 'active' | 'unbound' | 'conflict';
  createdAt: number;
  updatedAt: number;
}

interface BindingRegistry {
  version: number;
  bindings: AgentSessionBinding[];
}

// ============================================================
// Storage
// ============================================================

export function getBindingsPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, WORKSPACE_NAMESPACE, 'agent-sessions', 'bindings.json');
}

/**
 * Load the binding registry. Returns an empty registry when missing or
 * unreadable — callers must save explicitly to persist mutations.
 */
export function loadBindings(workspaceRootPath: string): BindingRegistry {
  const path = getBindingsPath(workspaceRootPath);
  if (!existsSync(path)) {
    return { version: BINDINGS_VERSION, bindings: [] };
  }
  try {
    const registry = readJsonFileSync<BindingRegistry>(path);
    if (!registry || !Array.isArray(registry.bindings)) {
      debug(`[bindings] bindings.json at ${path} has invalid shape, treating as empty`);
      return { version: BINDINGS_VERSION, bindings: [] };
    }
    return registry;
  } catch (err) {
    debug(
      `[bindings] failed to read bindings at ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
    return { version: BINDINGS_VERSION, bindings: [] };
  }
}

/**
 * Persist the binding registry (atomic write).
 */
export function saveBindings(workspaceRootPath: string, registry: BindingRegistry): void {
  const dir = join(workspaceRootPath, WORKSPACE_NAMESPACE, 'agent-sessions');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  atomicWriteFileSync(getBindingsPath(workspaceRootPath), JSON.stringify(registry, null, 2));
}

// ============================================================
// Queries
// ============================================================

/**
 * Get the binding for an agent, or null when none exists.
 */
export function getBinding(workspaceRootPath: string, agentId: string): AgentSessionBinding | null {
  return loadBindings(workspaceRootPath).bindings.find((b) => b.agentId === agentId) ?? null;
}

/**
 * List all bindings for a workspace.
 */
export function listBindings(workspaceRootPath: string): AgentSessionBinding[] {
  return loadBindings(workspaceRootPath).bindings;
}

/**
 * Resolve the current binding state for an agent without creating anything.
 * Never triggers a transition — stale active bindings (session deleted) are
 * returned as-is; only ensureAgentSession and unbindBySessionId transition.
 */
export function resolveBinding(workspaceRootPath: string, agentId: string): AgentSessionBinding | null {
  return getBinding(workspaceRootPath, agentId);
}

// ============================================================
// Ensure / Unbind
// ============================================================

/**
 * Ensure an agent has a canonical session in the workspace, creating one from
 * the agent's latest immutable revision when needed.
 *
 * - Reuses the existing canonical session when the binding is active.
 * - Replaces a dead/unbound binding with a fresh session (generation++).
 * - Never auto-resolves an explicit 'conflict' binding.
 *
 * @throws AgentSessionBindingError for unknown/retired agents, conflict
 * bindings, or missing revisions.
 */
export async function ensureAgentSession(
  workspaceRootPath: string,
  workspaceId: string,
  agentId: string
): Promise<SessionConfig> {
  // Agent must exist and be active.
  const agent = getAgent(agentId);
  if (!agent) {
    throw new AgentSessionBindingError('AGENT_NOT_FOUND', `Agent not found: ${agentId}`);
  }
  if (agent.status === 'retired') {
    throw new AgentSessionBindingError('AGENT_RETIRED', `Agent is retired: ${agentId}`);
  }

  const registry = loadBindings(workspaceRootPath);
  const binding = registry.bindings.find((b) => b.agentId === agentId);

  // Explicit conflict — never auto-resolve.
  if (binding?.state === 'conflict') {
    throw new AgentSessionBindingError(
      'AGENT_BINDING_CONFLICT',
      `Binding for agent ${agentId} is in conflict state; manual resolution required`
    );
  }

  // Reuse the existing live canonical session.
  if (binding?.state === 'active' && binding.canonicalSessionId) {
    const existing = loadSession(workspaceRootPath, binding.canonicalSessionId);
    if (existing) {
      return existing;
    }
    // Session gone — transition to unbound (generation preserved), then create
    // a fresh session below.
    binding.state = 'unbound';
    binding.canonicalSessionId = undefined;
    binding.updatedAt = Date.now();
  }

  // Create a new canonical session from the latest immutable revision.
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
    permissionMode: snapshot.permissionMode,
    thinkingLevel: snapshot.thinkingLevel,
    enabledSourceSlugs: snapshot.enabledSourceSlugs,
    model: snapshot.model,
  });

  // Persist / refresh the binding.
  const now = Date.now();
  if (binding) {
    binding.state = 'active';
    binding.canonicalSessionId = session.id;
    binding.generation += 1;
    binding.updatedAt = now;
  } else {
    registry.bindings.push({
      workspaceId,
      agentId,
      canonicalSessionId: session.id,
      generation: 1,
      state: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }
  saveBindings(workspaceRootPath, registry);

  return session;
}

/**
 * Unbind the binding whose canonical session is `sessionId`. Best-effort:
 * errors are logged and swallowed — never throws.
 */
export function unbindBySessionId(workspaceRootPath: string, sessionId: string): void {
  try {
    const registry = loadBindings(workspaceRootPath);
    const binding = registry.bindings.find((b) => b.canonicalSessionId === sessionId);
    if (!binding) return;

    binding.state = 'unbound';
    binding.canonicalSessionId = undefined;
    binding.updatedAt = Date.now();
    saveBindings(workspaceRootPath, registry);
  } catch (err) {
    debug(
      `[bindings] unbindBySessionId failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
