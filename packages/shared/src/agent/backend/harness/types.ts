/**
 * Harness Types and Interfaces (Issue #9)
 *
 * Abstraction layer for external agent harnesses (ADR #14 Decision 9):
 * ExternalHarnessBackend owns the native harness lifecycle through drivers;
 * each harness (codex, claude, kimi) implements HarnessDriver.
 *
 * The nativeSessionId is Craft/backend implementation truth — never exposed
 * as Project Service workflow identity (ADR Decision 9).
 */

/** Harness type discriminator (matches AgentExecutionConfig harness field) */
export type HarnessType = 'codex' | 'claude' | 'kimi' | 'pi'

import type { PermissionMode } from '../../mode-types.ts';

/** One model option a harness reports as available for the local config. */
export interface HarnessModelOption {
  /** Model identifier (harness-native). */
  id: string
  /** Human-readable display name (optional). */
  name?: string
  /** Thinking levels the harness reports this model supports. */
  thinkingLevels?: string[]
}

/** Option ranges a harness can report for its configuration surface. */
export interface HarnessOptions {
  models: HarnessModelOption[]
  permissionModes?: PermissionMode[]
}

/**
 * Native harness session. The nativeSessionId is Craft/backend implementation
 * truth — never exposed as Project Service workflow identity (ADR Decision 9).
 *
 * Lazy-materializing drivers (SDK-based, e.g. claude) may start with an EMPTY
 * nativeSessionId from create() and report the real id via a `session_bound`
 * event during the first run — the backend persists it then (restart-safe).
 */
export interface HarnessSession {
  /** Native harness session identifier (may start empty for lazy drivers) */
  nativeSessionId: string
  /** True when explicitly created/bound by this Craft installation */
  managed: boolean
}

/** Normalized events emitted by harness drivers, converted to AgentEvent by the backend. */
export type HarnessEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'text_complete'; text: string }
  | { type: 'tool_start'; toolName: string; toolUseId: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; toolName?: string; result: string; isError: boolean }
  | { type: 'permission_request'; requestId: string; toolName: string; description: string; command?: string }
  | { type: 'error'; message: string }
  | { type: 'complete'; usage?: { inputTokens: number; outputTokens: number } }
  | {
      /** Lazy-materializing drivers report the real native session id during
       * the first run; the backend persists it via onSdkSessionIdUpdate. */
      type: 'session_bound'
      nativeSessionId: string
    }

/** Arguments for creating a new harness session */
export interface HarnessCreateArgs {
  workspaceRootPath: string
  /** Omitted for 'local-inherit' mode — the harness uses its own local config. */
  systemPrompt?: string
  model?: string
  workingDirectory?: string
  permissionMode?: string
  thinkingLevel?: string
  enabledSourceSlugs?: string[]
  /** 'local-inherit': harness uses its own local config. 'managed': Craft provides all config. */
  configMode?: 'local-inherit' | 'managed'
}

/** Arguments for resuming an existing harness session */
export interface HarnessResumeArgs extends HarnessCreateArgs {
  nativeSessionId: string
}

/**
 * HarnessDriver — harness-specific lifecycle operations.
 * Each external harness (codex, claude, kimi) implements this interface.
 * ExternalHarnessBackend delegates all native operations to the driver.
 *
 * A discovered native session is NOT automatically considered managed/owned
 * (ADR Decision 9: DiscoveredHarnessSession != ManagedHarnessSession).
 */
export interface HarnessDriver {
  readonly harness: HarnessType

  /** Create a new native harness session */
  create(args: HarnessCreateArgs): Promise<HarnessSession>

  /** Resume an existing native harness session */
  resume(args: HarnessResumeArgs): Promise<HarnessSession>

  /** Send a message and stream back normalized events */
  run(session: HarnessSession, message: string): AsyncIterable<HarnessEvent>

  /** Gracefully interrupt the current operation (optional — default: no-op) */
  interrupt?(session: HarnessSession): Promise<void>

  /** Steer the in-flight turn with a new message (optional) */
  steer?(session: HarnessSession, message: string): Promise<void>

  /** Stop and tear down the native session */
  stop(session: HarnessSession): Promise<void>

  /**
   * Option ranges the harness reports for the CURRENT local configuration
   * (optional — harnesses without a queryable surface omit it). Editor
   * option lists derive from this instead of Craft-hardcoded values (W7).
   */
  listOptions?(): Promise<HarnessOptions>
}
