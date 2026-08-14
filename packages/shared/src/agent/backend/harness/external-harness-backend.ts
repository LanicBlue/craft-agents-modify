/**
 * ExternalHarnessBackend (Issue #9)
 *
 * Generic backend for external agent harnesses (ADR #14 Decision 9).
 * Owns the native harness lifecycle through a HarnessDriver:
 * - postInit() creates or resumes the native session (resume when a native
 *   session id is already persisted on the session — restart recovery).
 * - chatImpl() streams driver.run() events, normalized to AgentEvent.
 * - The native session id is stored via the onSdkSessionIdUpdate callback so
 *   postInit() can resume on restart.
 *
 * Not supported yet: mini completions, LLM queries, branching, attachments.
 */

import type { AgentEvent } from '@craft-agent/core/types';
import type { FileAttachment } from '../../../utils/files.ts';
import { BaseAgent } from '../../base-agent.ts';
import { AbortReason, type BackendConfig, type ChatOptions, type PostInitResult } from '../types.ts';
import type { LLMQueryRequest, LLMQueryResult } from '../../llm-tool.ts';
import type { HarnessDriver, HarnessEvent, HarnessSession, HarnessType } from './types.ts';
import { debug } from '../../../utils/debug.ts';

export interface ExternalHarnessBackendConfig extends BackendConfig {
  /** Harness discriminator (matches AgentExecutionConfig harness field) */
  harness: HarnessType;
  /** local-inherit: derive harness config from the local Craft install */
  configMode?: 'local-inherit' | 'managed';
  /** Harness-specific lifecycle driver */
  driver: HarnessDriver;
  /** System prompt from AgentProfileSnapshot */
  systemPrompt: string;
}

/**
 * Normalize a HarnessEvent into an AgentEvent understood by the session layer.
 * Exported for unit testing (Issue #9 Step 4).
 */
export function normalizeHarnessEvent(event: HarnessEvent): AgentEvent {
  switch (event.type) {
    case 'text_delta':
      return { type: 'text_delta', text: event.text };
    case 'text_complete':
      return { type: 'text_complete', text: event.text };
    case 'tool_start':
      return { type: 'tool_start', toolName: event.toolName, toolUseId: event.toolUseId, input: event.input };
    case 'tool_result':
      return { type: 'tool_result', toolUseId: event.toolUseId, toolName: event.toolName, result: event.result, isError: event.isError };
    case 'permission_request':
      return { type: 'permission_request', requestId: event.requestId, toolName: event.toolName, description: event.description, command: event.command };
    case 'error':
      return { type: 'error', message: event.message };
    case 'complete':
      return { type: 'complete', usage: event.usage };
  }
}

export class ExternalHarnessBackend extends BaseAgent {
  protected backendName = 'ExternalHarness';

  /** External harnesses don't support session branching initially. */
  protected override _supportsBranching = false;

  private readonly driver: HarnessDriver;
  private readonly harness: HarnessType;
  private readonly configMode?: 'local-inherit' | 'managed';
  private readonly systemPrompt: string;

  private session: HarnessSession | null = null;
  private _isProcessing = false;
  private readonly permissionResponses = new Map<
    string,
    { allowed: boolean; alwaysAllow?: boolean }
  >();

  constructor(config: ExternalHarnessBackendConfig) {
    // defaultModel is unused by external harnesses (the driver owns model
    // resolution); pass through the config model or an empty default.
    super(config, config.model ?? '');
    this.driver = config.driver;
    this.harness = config.harness;
    this.configMode = config.configMode;
    this.systemPrompt = config.systemPrompt;
  }

  /**
   * Create or resume the native harness session.
   * Resume when a native session id is already persisted (restart recovery).
   */
  async postInit(): Promise<PostInitResult> {
    const base = {
      workspaceRootPath: this.config.workspace.rootPath,
      systemPrompt: this.systemPrompt,
      model: this.config.model,
      workingDirectory: this.workingDirectory,
      permissionMode: this.config.session?.permissionMode,
      thinkingLevel: this.config.thinkingLevel,
      enabledSourceSlugs: this.config.session?.enabledSourceSlugs,
    };

    const nativeSessionId = this.config.session?.sdkSessionId;
    this.session = nativeSessionId
      ? await this.driver.resume({ ...base, nativeSessionId })
      : await this.driver.create(base);

    // Persist the native session id so postInit() can resume after a restart.
    this.config.onSdkSessionIdUpdate?.(this.session.nativeSessionId);
    return { authInjected: true };
  }

  protected async *chatImpl(
    message: string,
    attachments?: FileAttachment[],
    _options?: ChatOptions
  ): AsyncGenerator<AgentEvent> {
    if (attachments && attachments.length > 0) {
      debug(`[external-harness] ${attachments.length} attachment(s) ignored (not supported yet)`);
    }
    if (!this.session) {
      yield { type: 'error', message: 'External harness session not initialized' };
      return;
    }

    this._isProcessing = true;
    try {
      for await (const event of this.driver.run(this.session, message)) {
        yield normalizeHarnessEvent(event);
      }
    } finally {
      this._isProcessing = false;
    }
  }

  async abort(_reason?: string): Promise<void> {
    this.forceAbort();
  }

  forceAbort(reason: AbortReason = AbortReason.UserStop): void {
    if (!this.session) return;
    const session = this.session;
    if (this.driver.interrupt) {
      void this.driver.interrupt(session).catch((err) =>
        debug(`[external-harness] interrupt failed: ${err instanceof Error ? err.message : String(err)}`)
      );
    } else {
      void this.driver.stop(session).catch((err) =>
        debug(`[external-harness] stop on abort failed: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
  }

  isProcessing(): boolean {
    return this._isProcessing;
  }

  respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void {
    this.permissionResponses.set(requestId, { allowed, alwaysAllow });
  }

  /**
   * Read back a stored permission response (consumed by the driver via the
   * backend bridge in Issue #10). Undefined when no response was recorded.
   */
  getPermissionResponse(
    requestId: string
  ): { allowed: boolean; alwaysAllow?: boolean } | undefined {
    return this.permissionResponses.get(requestId);
  }

  async runMiniCompletion(_prompt: string): Promise<string | null> {
    // Mini completions are not supported for external harnesses.
    return null;
  }

  async queryLlm(_request: LLMQueryRequest): Promise<LLMQueryResult> {
    throw new Error('LLM queries are not supported for external harness backends');
  }

  destroy(): void {
    if (this.session) {
      const session = this.session;
      this.session = null;
      void this.driver.stop(session).catch((err) =>
        debug(`[external-harness] stop on destroy failed: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
    super.destroy();
  }
}

/** Factory entry used by SessionManager dispatch (Issue #9 Step 3). */
export function createExternalHarnessBackend(
  config: ExternalHarnessBackendConfig
): ExternalHarnessBackend {
  return new ExternalHarnessBackend(config);
}
