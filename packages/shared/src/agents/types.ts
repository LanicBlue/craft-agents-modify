/**
 * Agent Profile Domain Types
 *
 * AgentProfiles are versioned, immutable configuration snapshots for reusable
 * agents. A permanent logical identity (AgentRecord) references an immutable
 * revision chain (AgentProfileRevision) — every configuration change creates a
 * new revision; old revisions are never mutated.
 *
 * Storage is global (~/.craft-agent/agents/), not workspace-scoped.
 */

import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { PermissionMode } from '../agent/mode-types.ts';

/**
 * Permanent logical identity of an agent (per-agent agent.json, Issue #2).
 * `id` is caller-supplied, validated at creation (^[a-z][a-z0-9-]{0,63}$),
 * never silently normalized, and immutable for the lifetime of the record.
 */
export interface AgentRecord {
  /** Storage schema version (1). */
  schemaVersion: 1;
  /** Permanent identity. Validated format; immutable after creation. */
  id: string;
  /** Display name (mutable). */
  name: string;
  /** Lifecycle state. */
  status: 'active' | 'retired';
  /** Monotonic record version — CAS guard for concurrent updates. */
  recordVersion: number;
  /** Current latest revision number (starts at 1, increments on config changes). */
  latestProfileRevision: number;
  description?: string;
  capabilities?: string[];
  createdAt: number;
  updatedAt: number;
  /** Set when the agent is retired (kept forever; id never reused). */
  retiredAt?: number;
}

/**
 * Immutable versioned configuration snapshot.
 * Written once to revisions/revision-{n}.json and never modified.
 */
export interface AgentProfileRevision {
  agentId: string;
  /** Revision number, starting at 1 and strictly increasing. */
  revision: number;
  execution: AgentExecutionConfig;
  thinkingLevel?: ThinkingLevel;
  permissionMode?: PermissionMode;
  systemPrompt: string;
  enabledSourceSlugs?: string[];
  createdAt: number;
}

/**
 * Execution configuration discriminated union.
 * The `kind` discriminator strictly follows the Issue #2 spec:
 * - craft-backend: runs on the Craft agent backend
 * - external-harness: runs on an external agent harness (Codex/Claude/Kimi)
 */
export type AgentExecutionConfig =
  | {
      kind: 'craft-backend';
      /** LLM connection slug (optional — falls back to defaults). */
      llmConnection?: string;
      model?: string;
    }
  | {
      kind: 'external-harness';
      harness: 'codex' | 'claude' | 'kimi';
      model?: string;
      configMode?: 'local-inherit' | 'managed';
    };

/**
 * Resolved immutable agent configuration snapshot stored in a Session.
 * Created at session materialization time from an AgentProfileRevision.
 * Survives restart; never silently updated when AgentProfile changes.
 */
export interface AgentProfileSnapshot {
  execution: AgentExecutionConfig;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  permissionMode?: PermissionMode;
  systemPrompt: string;
  enabledSourceSlugs?: string[];
  /** Connection resolved at materialization (revision > workspace defaults). */
  llmConnection?: string;
  /** Epoch ms at materialization — inheritance is baked in exactly once. */
  resolvedAt: number;
}

/**
 * Input for creating a new agent. The agentId is generated internally and can
 * never be supplied by the caller.
 */
/**
 * Input for creating a new agent.
 * The stable id is REQUIRED and validated at creation
 * (^[a-z][a-z0-9-]{0,63}$) — never silently normalized.
 */
export interface CreateAgentInput {
  /** Stable, validated id. Immutable after creation; retired ids are never reused. */
  id: string;
  name: string;
  description?: string;
  capabilities?: string[];
  execution: AgentExecutionConfig;
  thinkingLevel?: ThinkingLevel;
  permissionMode?: PermissionMode;
  systemPrompt: string;
  enabledSourceSlugs?: string[];
}

/**
 * Input for updating an agent.
 * Metadata fields (name/description/capabilities) update the record in place;
 * execution/thinkingLevel/permissionMode/systemPrompt/enabledSourceSlugs
 * changes create a new immutable revision.
 */
export interface UpdateAgentInput {
  name?: string;
  description?: string;
  capabilities?: string[];
  execution?: AgentExecutionConfig;
  thinkingLevel?: ThinkingLevel;
  permissionMode?: PermissionMode;
  systemPrompt?: string;
  enabledSourceSlugs?: string[];
}

/**
 * On-disk registry structure — REMOVED with Issue #2: no registry.json;
 * the agents directory is the source of truth (list = readdir aggregation,
 * any future index is a rebuildable cache).
 */

export type AgentRegistryErrorCode =
  | 'AGENT_NOT_FOUND'
  | 'AGENT_ALREADY_EXISTS'
  | 'AGENT_ID_INVALID'
  | 'AGENT_VERSION_CONFLICT'
  | 'AGENT_PROFILE_INVALID'
  | 'AGENT_PROFILE_REVISION_NOT_FOUND'
  | 'AGENT_STORAGE_CORRUPT';

export class AgentRegistryError extends Error {
  constructor(public code: AgentRegistryErrorCode, message: string) {
    super(message);
    this.name = 'AgentRegistryError';
  }
}
