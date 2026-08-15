/**
 * Agent Profile Storage
 *
 * CRUD + lifecycle operations for the global AgentProfile registry (Issue #2).
 *
 * Layout (global, not workspace-scoped):
 *   {CONFIG_DIR}/agents/
 *     └── {agentId}/
 *         ├── agent.json                # AgentRecord (single source of truth)
 *         └── revisions/
 *             ├── 000001.json           # immutable AgentProfileRevision (6-digit)
 *             ├── 000002.json
 *             └── ...
 *
 * There is NO registry.json — the agents directory IS the registry.
 * listAgents aggregates by readdir; any future index is a rebuildable cache.
 *
 * Invariants:
 * - id is caller-supplied and validated (^[a-z][a-z0-9-]{0,63}$), never
 *   silently normalized; immutable after creation.
 * - Retired agents keep their identity and revision history; their id is never
 *   reused by another agent.
 * - Revisions are immutable — configuration updates append a new revision.
 * - recordVersion is a monotonic CAS guard: updates with a stale
 *   expectedRecordVersion fail with AGENT_VERSION_CONFLICT.
 * - The agent.json pointer is authoritative: a pointer to a missing/corrupt
 *   revision raises AGENT_STORAGE_CORRUPT — never a silent fallback to an old
 *   profile. Newer revision files not referenced by the pointer are orphans
 *   and are ignored.
 * - No credentials/tokens are ever stored.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from '../config/paths.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { debug } from '../utils/debug.ts';
import type { WorkspaceConfig } from '../workspaces/types.ts';
import { isValidThinkingLevel, type ThinkingLevel } from '../agent/thinking-levels.ts';
import { PERMISSION_MODE_ORDER } from '../agent/mode-types.ts';
import type {
  AgentExecutionConfig,
  AgentRecord,
  AgentProfileRevision,
  AgentProfileSnapshot,
  CreateAgentInput,
  UpdateAgentInput,
} from './types.ts';
import { AgentRegistryError } from './types.ts';

const SCHEMA_VERSION = 1 as const;

/** Stable ids: lowercase start, [a-z0-9-] thereafter, 1–64 chars. */
const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Validate an agent id before it is used to construct a file path, preventing
 * path traversal outside the agents directory. Invalid ids raise
 * AGENT_ID_INVALID (never silently normalized).
 */
function validateAgentId(agentId: string): string {
  if (typeof agentId !== 'string' || !AGENT_ID_PATTERN.test(agentId)) {
    throw new AgentRegistryError(
      'AGENT_ID_INVALID',
      `Invalid agent id: ${JSON.stringify(agentId)} (expected ^[a-z][a-z0-9-]{0,63}$)`
    );
  }
  return agentId;
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

/** First access initializes the (possibly empty) agents directory (#2: no migration). */
function ensureAgentsDir(): string {
  const dir = getAgentsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getAgentDir(agentId: string): string {
  return join(ensureAgentsDir(), validateAgentId(agentId));
}

function getAgentRecordPath(agentId: string): string {
  return join(getAgentDir(agentId), 'agent.json');
}

function getRevisionsDir(agentId: string): string {
  validateAgentId(agentId);
  return join(getAgentDir(agentId), 'revisions');
}

function getRevisionPath(agentId: string, revision: number): string {
  validateAgentId(agentId);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new AgentRegistryError('AGENT_PROFILE_REVISION_NOT_FOUND', `Invalid revision number: ${revision}`);
  }
  return join(getRevisionsDir(agentId), `${String(revision).padStart(6, '0')}.json`);
}

// ============================================================
// Record I/O
// ============================================================

/** Shape-validate an AgentRecord and optionally bind it to its directory id. */
function isValidRecord(record: unknown, expectedAgentId?: string): record is AgentRecord {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return false;
  const r = record as Record<string, unknown>;
  return (
    r.schemaVersion === SCHEMA_VERSION &&
    typeof r.id === 'string' &&
    AGENT_ID_PATTERN.test(r.id) &&
    (expectedAgentId === undefined || r.id === expectedAgentId) &&
    typeof r.name === 'string' &&
    (r.status === 'active' || r.status === 'retired') &&
    Number.isInteger(r.recordVersion) &&
    (r.recordVersion as number) >= 1 &&
    Number.isInteger(r.latestProfileRevision) &&
    (r.latestProfileRevision as number) >= 1 &&
    typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) &&
    typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) &&
    (r.retiredAt === undefined || (typeof r.retiredAt === 'number' && Number.isFinite(r.retiredAt))) &&
    (r.description === undefined || typeof r.description === 'string') &&
    (r.capabilities === undefined ||
      (Array.isArray(r.capabilities) && r.capabilities.every((value) => typeof value === 'string')))
  );
}

/** Load an agent record from its per-agent agent.json (null when absent). */
function loadRecord(agentId: string): AgentRecord | null {
  const recordPath = getAgentRecordPath(agentId);
  if (!existsSync(recordPath)) return null;
  try {
    const record = readJsonFileSync<AgentRecord>(recordPath);
    if (!isValidRecord(record, agentId)) {
      throw new AgentRegistryError('AGENT_STORAGE_CORRUPT', `Corrupt agent record for ${agentId} (invalid shape)`);
    }
    return record;
  } catch (err) {
    if (err instanceof AgentRegistryError) throw err;
    debug(`[agents] failed to read record at ${recordPath}: ${err instanceof Error ? err.message : String(err)}`);
    throw new AgentRegistryError('AGENT_STORAGE_CORRUPT', `Corrupt agent record for ${agentId}: unreadable agent.json`);
  }
}

/** Persist an agent record (atomic write). */
function saveRecord(record: AgentRecord): void {
  validateAgentId(record.id);
  const dir = getAgentDir(record.id);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  atomicWriteFileSync(getAgentRecordPath(record.id), JSON.stringify(record, null, 2));
}

// ============================================================
// Revision I/O
// ============================================================

/**
 * Write an immutable revision snapshot (atomic write, 6-digit zero-padded
 * file name).
 */
function saveRevision(revision: AgentProfileRevision): void {
  assertValidRevision(revision, revision.agentId, revision.revision);
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

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isValidExecutionConfig(execution: unknown): execution is AgentExecutionConfig {
  if (typeof execution !== 'object' || execution === null || Array.isArray(execution)) return false;
  const e = execution as Record<string, unknown>;
  if (!isOptionalString(e.model)) return false;

  if (e.kind === 'craft-backend') {
    return isOptionalString(e.llmConnection);
  }
  if (e.kind === 'external-harness') {
    return (
      (e.harness === 'codex' || e.harness === 'claude' || e.harness === 'kimi') &&
      (e.configMode === undefined || e.configMode === 'local-inherit' || e.configMode === 'managed')
    );
  }
  return false;
}

/**
 * Validate a persisted revision and bind its embedded identity to the file
 * requested by the caller. A well-shaped profile for another agent/revision
 * is still storage corruption and must never cross an identity boundary.
 */
function assertValidRevision(
  revision: unknown,
  expectedAgentId: string,
  expectedRevision: number
): asserts revision is AgentProfileRevision {
  if (typeof revision !== 'object' || revision === null || Array.isArray(revision)) {
    throw new AgentRegistryError('AGENT_PROFILE_INVALID', 'Invalid agent profile revision shape');
  }
  const r = revision as Record<string, unknown>;
  const valid =
    r.agentId === expectedAgentId &&
    r.revision === expectedRevision &&
    Number.isInteger(r.revision) &&
    (r.revision as number) >= 1 &&
    isValidExecutionConfig(r.execution) &&
    typeof r.systemPrompt === 'string' &&
    typeof r.createdAt === 'number' &&
    Number.isFinite(r.createdAt) &&
    (r.thinkingLevel === undefined || isValidThinkingLevel(r.thinkingLevel)) &&
    (r.permissionMode === undefined || PERMISSION_MODE_ORDER.includes(r.permissionMode as never)) &&
    (r.enabledSourceSlugs === undefined ||
      (Array.isArray(r.enabledSourceSlugs) &&
        r.enabledSourceSlugs.every((value) => typeof value === 'string')));
  if (!valid) {
    throw new AgentRegistryError('AGENT_PROFILE_INVALID', 'Invalid agent profile revision shape');
  }
}

/**
 * Load a specific revision file.
 *
 * @throws AGENT_PROFILE_REVISION_NOT_FOUND when the file does not exist,
 *         AGENT_PROFILE_INVALID when the file content is malformed.
 */
export function loadRevision(agentId: string, revision: number): AgentProfileRevision {
  const revisionPath = getRevisionPath(agentId, revision);
  if (!existsSync(revisionPath)) {
    throw new AgentRegistryError(
      'AGENT_PROFILE_REVISION_NOT_FOUND',
      `Revision ${revision} not found for agent ${agentId}`
    );
  }
  try {
    const parsed = readJsonFileSync<AgentProfileRevision>(revisionPath);
    assertValidRevision(parsed, agentId, revision);
    return parsed;
  } catch (err) {
    if (err instanceof AgentRegistryError) throw err;
    debug(`[agents] failed to read revision at ${revisionPath}: ${err instanceof Error ? err.message : String(err)}`);
    throw new AgentRegistryError('AGENT_PROFILE_INVALID', `Unreadable revision ${revision} for agent ${agentId}`);
  }
}

/**
 * Load the latest revision of an agent, following the agent.json pointer.
 * Returns null when the agent does not exist.
 *
 * A pointer to a missing or corrupt revision raises AGENT_STORAGE_CORRUPT —
 * never a silent fallback to an older profile.
 */
export function loadLatestRevision(agentId: string): AgentProfileRevision | null {
  const record = getAgent(agentId);
  if (!record) return null;
  try {
    return loadRevision(agentId, record.latestProfileRevision);
  } catch (err) {
    if (err instanceof AgentRegistryError && err.code !== 'AGENT_STORAGE_CORRUPT') {
      throw new AgentRegistryError(
        'AGENT_STORAGE_CORRUPT',
        `Agent ${agentId}: pointer to revision ${record.latestProfileRevision} is broken (${err.message}) — manual resolution required`
      );
    }
    throw err;
  }
}

/**
 * List all revisions for an agent, sorted ascending by revision number.
 * Only revisions <= the agent.json pointer (latestProfileRevision) are
 * included — newer unreferenced revision files are ORPHANS (crashed commit
 * leftovers) and never surface on any read path. Unreadable files are
 * skipped with a debug log (except the pointer target, which loadLatest
 * surfaces as corruption).
 */
export function listRevisions(agentId: string): AgentProfileRevision[] {
  validateAgentId(agentId);
  // The pointer is authoritative: without a record there is nothing to list.
  const record = loadRecord(agentId);
  if (!record) return [];
  if (!existsSync(getRevisionsDir(agentId))) return [];

  let entries: string[];
  try {
    entries = readdirSync(getRevisionsDir(agentId));
  } catch (err) {
    debug(`[agents] failed to list revisions at ${getRevisionsDir(agentId)}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const revisions: AgentProfileRevision[] = [];
  for (const entry of entries) {
    const match = /^(\d{6})\.json$/.exec(entry);
    if (!match) continue;
    const revisionNumber = Number(match[1]);
    if (revisionNumber > record.latestProfileRevision) continue; // orphan — ignore
    try {
      revisions.push(loadRevision(agentId, revisionNumber));
    } catch (err) {
      if (err instanceof AgentRegistryError && err.code === 'AGENT_PROFILE_REVISION_NOT_FOUND') continue;
      debug(`[agents] skipping unreadable revision ${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return revisions.sort((a, b) => a.revision - b.revision);
}

// ============================================================
// CRUD Operations
// ============================================================

/**
 * Global defaults layer for snapshot resolution (Wave 3 W3-2): values read
 * from the user's global config (config.json / config-defaults.json) at
 * materialization time by the caller (bindings.ensureAgentSession). Kept as
 * an explicit parameter so resolveAgentSnapshot stays a pure function with
 * deterministic tests.
 */
export interface SnapshotGlobalDefaults {
  defaultLlmConnection?: string;
  defaultThinkingLevel?: ThinkingLevel;
}

/**
 * Resolve the immutable AgentProfileSnapshot for a revision, applying the
 * inheritance chain ONCE at materialization time (Wave 2 R1a + W3-2):
 *
 *   revision value > workspace defaults > global defaults > hardcoded
 *
 * - permissionMode always resolves (hardcoded 'ask' fallback — no global
 *   config item exists for it).
 * - model / llmConnection resolve from execution > workspace defaults >
 *   global default connection, and stay ABSENT when nothing provides them
 *   (backend self-resolves).
 * - thinkingLevel: revision > workspace > global > 'medium'.
 * - enabledSourceSlugs: `undefined` inherits workspace defaults; an explicit
 *   `[]` is preserved (explicitly none).
 * - systemPrompt is revision-only (required, never inherited).
 * - resolvedAt pins the moment of resolution: later defaults changes never
 *   mutate existing snapshots.
 */
export function resolveAgentSnapshot(
  revision: AgentProfileRevision,
  defaults?: WorkspaceConfig['defaults'],
  globals?: SnapshotGlobalDefaults
): AgentProfileSnapshot {
  const snapshot: AgentProfileSnapshot = {
    execution: revision.execution,
    systemPrompt: revision.systemPrompt,
    permissionMode: revision.permissionMode ?? defaults?.permissionMode ?? 'ask',
    thinkingLevel:
      revision.thinkingLevel ?? defaults?.thinkingLevel ?? globals?.defaultThinkingLevel ?? 'medium',
    resolvedAt: Date.now(),
  };

  const model = revision.execution.model ?? defaults?.model;
  if (model !== undefined) {
    snapshot.model = model;
  }

  const llmConnection =
    revision.execution.kind === 'craft-backend'
      ? (revision.execution.llmConnection ??
        defaults?.defaultLlmConnection ??
        globals?.defaultLlmConnection)
      : (defaults?.defaultLlmConnection ?? globals?.defaultLlmConnection);
  if (llmConnection !== undefined) {
    snapshot.llmConnection = llmConnection;
  }

  // Explicit [] is preserved (explicitly none); undefined inherits.
  if (revision.enabledSourceSlugs !== undefined) {
    snapshot.enabledSourceSlugs = revision.enabledSourceSlugs;
  } else if (defaults?.enabledSourceSlugs !== undefined) {
    snapshot.enabledSourceSlugs = defaults.enabledSourceSlugs;
  }

  return snapshot;
}

/**
 * Create a new agent with a caller-supplied stable id: writes revision 1
 * first (so agent.json never points at a missing file), then the record.
 *
 * @throws AGENT_ID_INVALID (bad id format), AGENT_ALREADY_EXISTS (id taken).
 */
export function createAgent(input: CreateAgentInput): AgentRecord {
  validateAgentId(input.id);
  const id = input.id;
  const now = Date.now();

  const record: AgentRecord = {
    schemaVersion: SCHEMA_VERSION,
    id,
    name: input.name,
    status: 'active',
    recordVersion: 1,
    latestProfileRevision: 1,
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

  // All storage operations are synchronous single-process I/O — no async
  // interleave exists, so the commit sequence below is inherently serialized
  // (equivalent to holding the per-agent lock for its duration).
  if (existsSync(getAgentRecordPath(id))) {
    throw new AgentRegistryError('AGENT_ALREADY_EXISTS', `Agent already exists: ${id}`);
  }
  // Revision first — a record must never point at a missing file.
  saveRevision(revision);
  saveRecord(record);
  return record;
}

/**
 * Get an agent record by id. Returns null when not found.
 *
 * @throws AGENT_STORAGE_CORRUPT when the record file is unreadable/malformed.
 */
export function getAgent(agentId: string): AgentRecord | null {
  validateAgentId(agentId);
  return loadRecord(agentId);
}

/**
 * List agent records, aggregated from the agents directory (no registry.json).
 * Unreadable/malformed agent.json files are skipped with a debug log.
 */
export function listAgents(options?: { includeRetired?: boolean }): AgentRecord[] {
  const includeRetired = options?.includeRetired ?? false;
  const agentsDir = ensureAgentsDir();

  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch (err) {
    debug(`[agents] failed to list agents at ${agentsDir}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const agents: AgentRecord[] = [];
  for (const entry of entries) {
    if (entry === 'registry.json') {
      // Issue #2: legacy registry.json is never read or migrated (no stock
      // data per owner ruling) — ignore it.
      debug('[agents] ignoring legacy registry.json (Issue #2: no migration)');
      continue;
    }
    const recordPath = join(agentsDir, entry, 'agent.json');
    if (!existsSync(recordPath)) continue;
    try {
      const record = readJsonFileSync<AgentRecord>(recordPath);
      if (!isValidRecord(record, entry)) {
        debug(`[agents] skipping corrupt agent record at ${recordPath}`);
        continue;
      }
      agents.push(record);
    } catch (err) {
      debug(`[agents] skipping unreadable agent record at ${recordPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  agents.sort((a, b) => a.createdAt - b.createdAt);
  return includeRetired ? agents : agents.filter((agent) => agent.status === 'active');
}

/**
 * Update an agent with optimistic concurrency control.
 *
 * Metadata fields (name/description/capabilities) mutate the record in place
 * (recordVersion + 1). Configuration fields (execution/thinkingLevel/
 * permissionMode/systemPrompt/enabledSourceSlugs) commit a NEW immutable
 * revision via the atomic sequence:
 *
 *   lock → CAS check → write N+1 temp → rename publish → pointer bump +
 *   recordVersion+1 (atomic agent.json write) → unlock
 *
 * @param expectedRecordVersion - CAS guard; when provided and stale, throws
 *   AGENT_VERSION_CONFLICT. Absent = no concurrency guard (callers without
 *   version awareness, e.g. the RPC layer pre-R2b).
 */
export function updateAgent(
  agentId: string,
  input: UpdateAgentInput,
  expectedRecordVersion?: number
): AgentRecord {
  validateAgentId(agentId);
  {
    const record = loadRecord(agentId);
    if (!record) {
      throw new AgentRegistryError('AGENT_NOT_FOUND', `Agent not found: ${agentId}`);
    }
    assertRecordVersion(record, expectedRecordVersion);

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

    // Configuration updates — commit a new immutable revision.
    const hasConfigChanges =
      input.execution !== undefined ||
      input.thinkingLevel !== undefined ||
      input.permissionMode !== undefined ||
      input.systemPrompt !== undefined ||
      input.enabledSourceSlugs !== undefined;

    if (hasConfigChanges) {
      const previous = loadRevisionOrCorrupt(agentId, record);
      const nextRevisionNumber = record.latestProfileRevision + 1;

      const execution = input.execution ?? previous.execution;
      const systemPrompt = input.systemPrompt ?? previous.systemPrompt;

      const revision: AgentProfileRevision = {
        agentId,
        revision: nextRevisionNumber,
        execution,
        systemPrompt,
        createdAt: Date.now(),
      };
      if (input.thinkingLevel !== undefined) {
        revision.thinkingLevel = input.thinkingLevel;
      } else if (previous.thinkingLevel !== undefined) {
        revision.thinkingLevel = previous.thinkingLevel;
      }
      if (input.permissionMode !== undefined) {
        revision.permissionMode = input.permissionMode;
      } else if (previous.permissionMode !== undefined) {
        revision.permissionMode = previous.permissionMode;
      }
      if (input.enabledSourceSlugs !== undefined) {
        revision.enabledSourceSlugs = input.enabledSourceSlugs;
      } else if (previous.enabledSourceSlugs !== undefined) {
        revision.enabledSourceSlugs = previous.enabledSourceSlugs;
      }

      assertValidRevision(revision, agentId, nextRevisionNumber);

      // Write N+1 temp file → atomic rename publish → pointer bump + CAS
      // recordVersion in one atomic agent.json write.
      const revisionsDir = getRevisionsDir(agentId);
      if (!existsSync(revisionsDir)) {
        mkdirSync(revisionsDir, { recursive: true });
      }
      const targetPath = getRevisionPath(agentId, nextRevisionNumber);
      const tempPath = join(revisionsDir, `${String(nextRevisionNumber).padStart(6, '0')}.json.tmp-${Date.now()}`);
      writeFileSync(tempPath, JSON.stringify(revision, null, 2), 'utf-8');
      renameSync(tempPath, targetPath);

      record.latestProfileRevision = nextRevisionNumber;
      changed = true;
    }

    if (changed) {
      record.recordVersion += 1;
      record.updatedAt = Date.now();
      saveRecord(record);
    }

    return record;
  }
}

/** Load the revision the pointer references, surfacing corruption explicitly. */
function loadRevisionOrCorrupt(agentId: string, record: AgentRecord): AgentProfileRevision {
  try {
    return loadRevision(agentId, record.latestProfileRevision);
  } catch (err) {
    throw new AgentRegistryError(
      'AGENT_STORAGE_CORRUPT',
      `Agent ${agentId}: pointer to revision ${record.latestProfileRevision} is broken (${err instanceof Error ? err.message : String(err)}) — manual resolution required`
    );
  }
}

function assertRecordVersion(record: AgentRecord, expectedRecordVersion?: number): void {
  if (expectedRecordVersion !== undefined && expectedRecordVersion !== record.recordVersion) {
    throw new AgentRegistryError(
      'AGENT_VERSION_CONFLICT',
      `Agent ${record.id}: recordVersion conflict (expected ${expectedRecordVersion}, current ${record.recordVersion})`
    );
  }
}

/**
 * Retire an agent: status → 'retired'. Only status/timestamps/recordVersion
 * change — Sessions, Bindings and revisions are never touched. Idempotent for
 * already-retired agents.
 */
export function retireAgent(agentId: string, expectedRecordVersion?: number): AgentRecord {
  validateAgentId(agentId);
  {
    const record = loadRecord(agentId);
    if (!record) {
      throw new AgentRegistryError('AGENT_NOT_FOUND', `Agent not found: ${agentId}`);
    }
    assertRecordVersion(record, expectedRecordVersion);
    if (record.status !== 'retired') {
      record.status = 'retired';
      record.retiredAt = Date.now();
      record.recordVersion += 1;
      record.updatedAt = Date.now();
      saveRecord(record);
    }
    return record;
  }
}

/**
 * Restore a retired agent: status → 'active'. Idempotent for active agents.
 */
export function restoreAgent(agentId: string, expectedRecordVersion?: number): AgentRecord {
  validateAgentId(agentId);
  {
    const record = loadRecord(agentId);
    if (!record) {
      throw new AgentRegistryError('AGENT_NOT_FOUND', `Agent not found: ${agentId}`);
    }
    assertRecordVersion(record, expectedRecordVersion);
    if (record.status !== 'active') {
      record.status = 'active';
      record.recordVersion += 1;
      record.updatedAt = Date.now();
      saveRecord(record);
    }
    return record;
  }
}
