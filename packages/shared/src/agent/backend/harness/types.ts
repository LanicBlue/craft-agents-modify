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
export type HarnessType = 'codex' | 'claude' | 'kimi'

/**
 * Native harness session. The nativeSessionId is Craft/backend implementation
 * truth — never exposed as Project Service workflow identity (ADR Decision 9).
 */
export interface HarnessSession {
  /** Native harness session identifier */
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

/** Arguments for creating a new harness session */
export interface HarnessCreateArgs {
  workspaceRootPath: string
  systemPrompt: string
  model?: string
  workingDirectory?: string
  permissionMode?: string
  thinkingLevel?: string
  enabledSourceSlugs?: string[]
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
}
