/**
 * Agent Profile Storage
 *
 * CRUD + lifecycle operations for the global AgentProfile registry.
 *
 * Layout (global, not workspace-scoped):
 *   ~/.craft-agent/agents/
 *     ├── registry.json                  # AgentRegistry (AgentRecord list)
 *     └── {agentId}/
 *         └── revisions/
 *             ├── revision-1.json        # immutable AgentProfileRevision
 *             ├── revision-2.json
 *             └── ...
 *
 * Invariants:
 * - agentId is generated at creation and never changes (no re-assignment API).
 * - Retired agents keep their identity and revision history; their id is never
 *   reused by another agent.
 * - Revisions are immutable — configuration updates append a new revision.
 * - No credentials/tokens are ever stored.
 */

import { existsSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { CONFIG_DIR } from '../config/paths.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { debug } from '../utils/debug.ts';
import type {
  AgentRecord,
  AgentProfileRevision,
  AgentProfileSnapshot,
  AgentRegistry,
  CreateAgentInput,
  UpdateAgentInput,
} from './types.ts';

const REGISTRY_VERSION = 1;

const AGENT_ID_PATTERN = /^agent_[a-f0-9]{8}$/;

/**
 * Validate an agent id before it is used to construct a file path, preventing
 * path traversal outside the agents directory.
 */
function validateAgentId(agentId: string): string {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`Invalid agent ID: ${agentId}`);
  }
  return agentId;
}

/**
 * Best-effort: rename a corrupt registry file out of the way so it can never
 * be silently overwritten by a later save (which would orphan all revisions).
 */
function backupCorruptRegistry(registryPath: string): void {
  const backupPath = `${registryPath}.corrupt-${Date.now()}`;
  try {
    renameSync(registryPath, backupPath);
    debug(`[agents] Backed up corrupt registry to ${backupPath}`);
  } catch (err) {
    debug(
      `[agents] failed to back up corrupt registry at ${registryPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ============================================================
// Path Utilities
// ============================================================

function getAgentsDir(): string {
  // Resolve at call time: CRAFT_CONFIG_DIR lets tests isolate the registry
  // regardless of module load order (bun test workers reuse processes across
  // files, so load-time capture of CONFIG_DIR would be racy). In production
  // the env var is unset and this falls back to CONFIG_DIR.
  return join(process.env.CRAFT_CONFIG_DIR ?? CONFIG_DIR, 'agents');
}

function getRegistryPath(): string {
  return join(getAgentsDir(), 'registry.json');
}

function getAgentDir(agentId: string): string {
  return join(getAgentsDir(), validateAgentId(agentId));
}

function getRevisionsDir(agentId: string): string {
  validateAgentId(agentId);
  return join(getAgentDir(agentId), 'revisions');
}

function getRevisionPath(agentId: string, revision: number): string {
  validateAgentId(agentId);
  return join(getRevisionsDir(agentId), `revision-${revision}.json`);
}

// ============================================================
// Registry I/O
// ============================================================

/**
 * Load the agent registry. Returns an empty registry when the file is missing
 * or unreadable — callers must save explicitly to persist mutations.
 *
 * A corrupt file (parse failure or invalid shape) is renamed to
 * registry.json.corrupt-<timestamp> before an empty registry is returned, so
 * a later save can never silently destroy the previous registry data.
 */
export function loadAgentRegistry(): AgentRegistry {
  const registryPath = getRegistryPath();
  if (!existsSync(registryPath)) {
    return { version: REGISTRY_VERSION, agents: [] };
  }

  try {
    const registry = readJsonFileSync<AgentRegistry>(registryPath);
    if (!registry || !Array.isArray(registry.agents)) {
      debug(`[agents] registry.json at ${registryPath} has invalid shape, backing up and treating as empty`);
      backupCorruptRegistry(registryPath);
      return { version: REGISTRY_VERSION, agents: [] };
    }
    return registry;
  } catch (err) {
    debug(`[agents] failed to read registry at ${registryPath}: ${err instanceof Error ? err.message : String(err)}`);
    backupCorruptRegistry(registryPath);
    return { version: REGISTRY_VERSION, agents: [] };
  }
}

/**
 * Persist the agent registry (atomic write).
 */
export function saveAgentRegistry(registry: AgentRegistry): void {
  const dir = getAgentsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  atomicWriteFileSync(getRegistryPath(), JSON.stringify(registry, null, 2));
}

// ============================================================
// Revision I/O
// ============================================================

/**
 * Write an immutable revision snapshot (atomic write).
 */
export function saveRevision(revision: AgentProfileRevision): void {
  validateAgentId(revision.agentId);
  const revisionsDir = getRevisionsDir(revision.agentId);
  if (!existsSync(revisionsDir)) {
    mkdirSync(revisionsDir, { recursive: true });
  }
  atomicWriteFileSync(
    getRevisionPath(revision.agentId, revision.revision),
    JSON.stringify(revision, null, 2)
  );
}

/**
 * Load a specific revision. Returns null when missing or unreadable.
 */
export function loadRevision(agentId: string, revision: number): AgentProfileRevision | null {
  validateAgentId(agentId);
  const revisionPath = getRevisionPath(agentId, revision);
  if (!existsSync(revisionPath)) return null;
  try {
    return readJsonFileSync<AgentProfileRevision>(revisionPath);
  } catch (err) {
    debug(`[agents] failed to read revision at ${revisionPath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Load the latest revision of an agent (from AgentRecord.latestRevision).
 * Returns null when the agent or its revision file is missing.
 */
export function loadLatestRevision(agentId: string): AgentProfileRevision | null {
  const record = getAgent(agentId);
  if (!record) return null;
  return loadRevision(agentId, record.latestRevision);
}

/**
 * List all revisions for an agent, sorted ascending by revision number.
 * Unreadable/missing files are skipped.
 */
export function listRevisions(agentId: string): AgentProfileRevision[] {
  validateAgentId(agentId);
  const revisionsDir = getRevisionsDir(agentId);
  if (!existsSync(revisionsDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(revisionsDir);
  } catch (err) {
    debug(`[agents] failed to list revisions at ${revisionsDir}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const revisions: AgentProfileRevision[] = [];
  for (const entry of entries) {
    const match = /^revision-(\d+)\.json$/.exec(entry);
    if (!match) continue;
    const revision = loadRevision(agentId, Number(match[1]));
    if (revision) revisions.push(revision);
  }

  return revisions.sort((a, b) => a.revision - b.revision);
}

// ============================================================
// CRUD Operations
// ============================================================

/**
 * Resolve an immutable configuration snapshot from an AgentProfileRevision.
 * Used at session materialization time (Issue #4 ensureAgentSession).
 */
export function resolveAgentSnapshot(
  revision: AgentProfileRevision
): AgentProfileSnapshot {
  const snapshot: AgentProfileSnapshot = {
    execution: revision.execution,
    systemPrompt: revision.systemPrompt,
  };
  // Resolve model from execution config
  if (revision.execution.model !== undefined) {
    snapshot.model = revision.execution.model;
  }
  if (revision.thinkingLevel !== undefined) {
    snapshot.thinkingLevel = revision.thinkingLevel;
  }
  if (revision.permissionMode !== undefined) {
    snapshot.permissionMode = revision.permissionMode;
  }
  if (revision.enabledSourceSlugs !== undefined) {
    snapshot.enabledSourceSlugs = revision.enabledSourceSlugs;
  }
  return snapshot;
}

/**
 * Create a new agent: generates a fresh immutable agentId, writes revision 1,
 * and appends the record to the registry.
 */
export function createAgent(input: CreateAgentInput): AgentRecord {
  const id = `agent_${randomUUID().slice(0, 8)}`;
  const now = Date.now();

  const record: AgentRecord = {
    id,
    name: input.name,
    status: 'active',
    latestRevision: 1,
    createdAt: now,
    updatedAt: now,
  };
  if (input.description !== undefined) record.description = input.description;
  if (input.capabilities !== undefined) record.capabilities = input.capabilities;

  const revision: AgentProfileRevision = {
    agentId: id,
    revision: 1,
    execution: input.execution,
    systemPrompt: input.systemPrompt,
    createdAt: now,
  };
  if (input.thinkingLevel !== undefined) revision.thinkingLevel = input.thinkingLevel;
  if (input.permissionMode !== undefined) revision.permissionMode = input.permissionMode;
  if (input.enabledSourceSlugs !== undefined) revision.enabledSourceSlugs = input.enabledSourceSlugs;

  // Write the revision first so a registry entry never points at a missing file.
  saveRevision(revision);

  const registry = loadAgentRegistry();
  registry.agents.push(record);
  saveAgentRegistry(registry);

  return record;
}

/**
 * Get an agent record by id. Returns null when not found.
 */
export function getAgent(agentId: string): AgentRecord | null {
  return loadAgentRegistry().agents.find((agent) => agent.id === agentId) ?? null;
}

/**
 * List agent records. Retired agents are excluded unless includeRetired is set.
 */
export function listAgents(options?: { includeRetired?: boolean }): AgentRecord[] {
  const includeRetired = options?.includeRetired ?? false;
  const agents = loadAgentRegistry().agents;
  return includeRetired ? agents : agents.filter((agent) => agent.status === 'active');
}

/**
 * Update an agent.
 *
 * Metadata fields (name/description/capabilities) mutate the record in place.
 * Configuration fields (execution/thinkingLevel/permissionMode/systemPrompt/
 * enabledSourceSlugs) create a NEW immutable revision and bump latestRevision.
 *
 * @throws Error when the agent does not exist.
 */
export function updateAgent(agentId: string, input: UpdateAgentInput): AgentRecord {
  const registry = loadAgentRegistry();
  const index = registry.agents.findIndex((agent) => agent.id === agentId);
  if (index === -1) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const record = registry.agents[index]!;
  let changed = false;

  // Metadata updates — mutate the record in place, no new revision.
  if (input.name !== undefined) {
    record.name = input.name;
    changed = true;
  }
  if (input.description !== undefined) {
    record.description = input.description;
    changed = true;
  }
  if (input.capabilities !== undefined) {
    record.capabilities = input.capabilities;
    changed = true;
  }

  // Configuration updates — create a new immutable revision.
  const hasConfigChanges =
    input.execution !== undefined ||
    input.thinkingLevel !== undefined ||
    input.permissionMode !== undefined ||
    input.systemPrompt !== undefined ||
    input.enabledSourceSlugs !== undefined;

  if (hasConfigChanges) {
    const nextRevisionNumber = record.latestRevision + 1;
    const previous = loadRevision(agentId, record.latestRevision);

    const execution = input.execution ?? previous?.execution;
    const systemPrompt = input.systemPrompt ?? previous?.systemPrompt;
    if (!execution || !systemPrompt) {
      throw new Error(
        `Cannot update agent ${agentId}: base revision is missing or incomplete`
      );
    }

    const revision: AgentProfileRevision = {
      agentId,
      revision: nextRevisionNumber,
      execution,
      systemPrompt,
      createdAt: Date.now(),
    };
    if (input.thinkingLevel !== undefined) {
      revision.thinkingLevel = input.thinkingLevel;
    } else if (previous?.thinkingLevel !== undefined) {
      revision.thinkingLevel = previous.thinkingLevel;
    }
    if (input.permissionMode !== undefined) {
      revision.permissionMode = input.permissionMode;
    } else if (previous?.permissionMode !== undefined) {
      revision.permissionMode = previous.permissionMode;
    }
    if (input.enabledSourceSlugs !== undefined) {
      revision.enabledSourceSlugs = input.enabledSourceSlugs;
    } else if (previous?.enabledSourceSlugs !== undefined) {
      revision.enabledSourceSlugs = previous.enabledSourceSlugs;
    }

    saveRevision(revision);
    record.latestRevision = nextRevisionNumber;
    changed = true;
  }

  if (changed) {
    record.updatedAt = Date.now();
    saveAgentRegistry(registry);
  }

  return record;
}

/**
 * Retire an agent: status → 'retired'. Identity and revision history are kept;
 * the id is never reused. Idempotent for already-retired agents.
 *
 * @throws Error when the agent does not exist.
 */
export function retireAgent(agentId: string): AgentRecord {
  const registry = loadAgentRegistry();
  const record = registry.agents.find((agent) => agent.id === agentId);
  if (!record) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  record.status = 'retired';
  record.updatedAt = Date.now();
  saveAgentRegistry(registry);
  return record;
}

/**
 * Restore a retired agent: status → 'active'. Idempotent for active agents.
 *
 * @throws Error when the agent does not exist.
 */
export function restoreAgent(agentId: string): AgentRecord {
  const registry = loadAgentRegistry();
  const record = registry.agents.find((agent) => agent.id === agentId);
  if (!record) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  record.status = 'active';
  record.updatedAt = Date.now();
  saveAgentRegistry(registry);
  return record;
}
