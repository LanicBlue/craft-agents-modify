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
 * Permanent logical identity of an agent.
 * `id` is generated at creation (agent_{8-char-uuid}) and is immutable for the
 * lifetime of the record — updates never accept an agentId parameter.
 */
export interface AgentRecord {
  /** Permanent identity. Format: agent_{8-char-uuid}. Immutable after creation. */
  id: string;
  /** Display name (mutable). */
  name: string;
  /** Lifecycle state. */
  status: 'active' | 'retired';
  /** Current latest revision number (starts at 1, increments on config changes). */
  latestRevision: number;
  description?: string;
  capabilities?: string[];
  createdAt: number;
  updatedAt: number;
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
 * Input for creating a new agent. The agentId is generated internally and can
 * never be supplied by the caller.
 */
export interface CreateAgentInput {
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
 * On-disk registry structure.
 */
export interface AgentRegistry {
  version: number;
  agents: AgentRecord[];
}
