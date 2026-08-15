/**
 * ClaudeSdkDriver — HarnessDriver over the official Claude Agent SDK
 * (@anthropic-ai/claude-agent-sdk, Issue #17 W5-2).
 *
 * Design notes (owner-ruled direction):
 * - Official SDK, NOT a CLI subprocess (stronger control).
 * - configMode 'local-inherit' (the default): NO systemPrompt/model/apiKey —
 *   the SDK runs on the user's local native Claude configuration (OAuth).
 *   'managed': Craft supplies systemPrompt/model.
 * - Lazy materialization: the SDK has no explicit "create" — a native session
 *   materializes on the first query and its real id is reported via a
 *   `session_bound` event during run() (backend persists it, W5-1).
 * - Resume is validated by the first query({ resume }): a failed resume
 *   terminates the stream with an error event — NEVER a silent fork into a
 *   fresh context (#17 Gate B red line).
 *
 * Reference semantics only (no code reuse): agent-session-control's
 * claude-agent-sdk adapter (resume via query({ resume }), history rebuild
 * gating).
 */

import { query, type Query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { debug } from '../../../../utils/debug.ts';
import type {
  HarnessDriver,
  HarnessSession,
  HarnessEvent,
  HarnessCreateArgs,
  HarnessResumeArgs,
} from '../types.ts';

/** Per-session context captured at create/resume time (run() only receives
 * the HarnessSession handle). */
interface SessionContext {
  cwd: string;
  configMode?: 'local-inherit' | 'managed';
  systemPrompt?: string;
  model?: string;
  /** True when this session was resumed (never silently re-created). */
  resumed: boolean;
}

export class ClaudeSdkDriver implements HarnessDriver {
  readonly harness = 'claude' as const;

  /** Context per live session object (WeakMap — no leaks, no key collisions
   * across concurrent sessions sharing this singleton driver). */
  private readonly contexts = new WeakMap<HarnessSession, SessionContext>();

  private activeQuery: Query | null = null;
  private activeAbort: AbortController | null = null;

  /** Create is lazy: no SDK call happens here. The native session is
   * materialized by the first run(); its real id is reported via
   * `session_bound` (empty id placeholder until then). */
  async create(args: HarnessCreateArgs): Promise<HarnessSession> {
    const session: HarnessSession = { nativeSessionId: '', managed: true };
    this.contexts.set(session, {
      cwd: args.workspaceRootPath,
      configMode: args.configMode,
      systemPrompt: args.systemPrompt,
      model: args.model,
      resumed: false,
    });
    return session;
  }

  /** No SDK call here either — resume validation happens inside the first
   * run()'s query({ resume }). A failed resume surfaces as an error event and
   * terminates the stream (never silently forking a new context). */
  async resume(args: HarnessResumeArgs): Promise<HarnessSession> {
    const session: HarnessSession = { nativeSessionId: args.nativeSessionId, managed: true };
    this.contexts.set(session, {
      cwd: args.workspaceRootPath,
      configMode: args.configMode,
      systemPrompt: args.systemPrompt,
      model: args.model,
      resumed: true,
    });
    return session;
  }

  async *run(session: HarnessSession, message: string): AsyncIterable<HarnessEvent> {
    const ctx = this.contexts.get(session);
    if (!ctx) {
      yield { type: 'error', message: 'Claude SDK session not initialized' };
      return;
    }

    const abort = new AbortController();
    this.activeAbort = abort;

    const options: Options = {
      cwd: ctx.cwd,
      abortController: abort,
      // Incremental text via stream_event messages (same shape ClaudeAgent uses).
      includePartialMessages: true,
    };
    // configMode 'managed': Craft supplies the profile. 'local-inherit'
    // (default): the SDK runs on the user's local Claude configuration.
    if (ctx.configMode === 'managed') {
      if (ctx.systemPrompt !== undefined) options.systemPrompt = ctx.systemPrompt;
      if (ctx.model !== undefined) options.model = ctx.model;
    }
    if (session.nativeSessionId) {
      options.resume = session.nativeSessionId;
    }

    let stream: Query | null = null;
    try {
      stream = query({ prompt: message, options });
      this.activeQuery = stream;

      let boundId = session.nativeSessionId;
      for await (const msg of stream) {
        // session_id appears on (nearly) every SDK message — first change
        // binds the real native id (idempotent: identical ids are skipped).
        const sid = (msg as { session_id?: unknown }).session_id;
        if (typeof sid === 'string' && sid.length > 0 && sid !== boundId) {
          boundId = sid;
          yield { type: 'session_bound', nativeSessionId: sid };
        }
        for (const event of mapSdkMessage(msg)) {
          yield event;
        }
      }
    } catch (err) {
      // Resume failure or stream error: explicit error event, stream ends —
      // never a silent retry or a fresh-context fork (#17 Gate B red line).
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : `Claude SDK query failed: ${String(err)}`,
      };
    } finally {
      if (this.activeQuery === stream) this.activeQuery = null;
      this.activeAbort = null;
    }
  }

  /** Graceful SDK interrupt (query.interrupt()); abort controller as backstop. */
  async interrupt(session: HarnessSession): Promise<void> {
    const stream = this.activeQuery;
    if (stream && typeof stream.interrupt === 'function') {
      try {
        await stream.interrupt();
        return;
      } catch (err) {
        debug(`[claude-sdk] interrupt request failed, falling back to abort: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.activeAbort?.abort();
  }

  /** Tear down: abort the in-flight query. Contexts are WeakMap-held. */
  async stop(_session: HarnessSession): Promise<void> {
    this.activeAbort?.abort();
    this.activeQuery = null;
  }
}

/**
 * Map one SDK message to zero-or-more HarnessEvents.
 * Structural mapping only (no dependency on ClaudeAgent's adapter).
 */
function mapSdkMessage(msg: SDKMessage): HarnessEvent[] {
  switch (msg.type) {
    case 'stream_event': {
      // SDKPartialAssistantMessage — incremental deltas (includePartialMessages).
      const event = msg.event;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        return [{ type: 'text_delta', text: event.delta.text }];
      }
      return [];
    }
    case 'assistant': {
      const events: HarnessEvent[] = [];
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            events.push({ type: 'text_delta', text: block.text });
          } else if (block.type === 'tool_use') {
            events.push({
              type: 'tool_start',
              toolName: block.name,
              toolUseId: block.id,
              input: (block.input ?? {}) as Record<string, unknown>,
            });
          }
        }
      }
      return events;
    }
    case 'user': {
      // Tool results ride on SDK user messages.
      const events: HarnessEvent[] = [];
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const result =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .map((part) => (typeof part === 'string' ? part : part.type === 'text' ? part.text : JSON.stringify(part)))
                      .join('\n')
                  : JSON.stringify(block.content);
            events.push({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              result,
              isError: block.is_error === true,
            });
          }
        }
      }
      return events;
    }
    case 'result': {
      if (msg.subtype === 'success' && !msg.is_error) {
        return [
          {
            type: 'complete',
            usage: {
              inputTokens: msg.usage?.input_tokens ?? 0,
              outputTokens: msg.usage?.output_tokens ?? 0,
            },
          },
        ];
      }
      // error_during_execution / error_max_turns / ... — explicit error, the
      // stream terminates (no silent fork, no retry).
      const detail =
        msg.subtype === 'error_during_execution' && Array.isArray(msg.errors) && msg.errors.length > 0
          ? msg.errors.join('; ')
          : msg.subtype;
      return [{ type: 'error', message: `Claude session failed: ${detail}` }];
    }
    default:
      // system/init, status, permission control messages etc. carry the
      // session_id (already handled) but no user-facing events.
      return [];
  }
}
