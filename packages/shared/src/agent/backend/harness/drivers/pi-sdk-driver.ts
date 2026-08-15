/**
 * PiSdkDriver — HarnessDriver over the in-process Pi coding agent SDK
 * (@earendil-works/pi-coding-agent, Issue #17 W6-1).
 *
 * Design notes (owner-ruled direction, Wave 6):
 * - In-process SDK driver (aligned with the claude driver and the reference
 *   project), NOT a CLI subprocess.
 * - create is EAGER (pi has an explicit create; Gate B determinism first):
 *   createAgentSession({ cwd }) — nativeSessionId = session.sessionFile ??
 *   session.sessionId (sessionFile preferred — resume is file-based).
 * - resume restores EXACTLY by nativeSessionId: SessionManager.open(file).
 *   A missing/corrupt session file is an explicit error — NEVER a silent
 *   fresh session (Gate B red line, same as the claude driver).
 * - configMode 'local-inherit' (default): only cwd is passed — model and
 *   provider config all come from the user's local pi config (~/.pi).
 *   'managed' is explicitly NOT supported in P0: create/resume throw a clear
 *   error instead of half-resolving provider/model.
 * - interrupt = session.abort(); stop = abort; steer is unimplemented.
 * - Event mapping: message_update (assistant deltas / final text) →
 *   text_delta / text_complete (final-text semantics at turn boundaries,
 *   aligned with the claude driver); tool_execution_start/end →
 *   tool_start/tool_result; agent_end → complete (+ usage when available).
 */

import { existsSync } from 'fs';
import { createAgentSession, SessionManager, type AgentSession, type AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  HarnessDriver,
  HarnessSession,
  HarnessEvent,
  HarnessCreateArgs,
  HarnessResumeArgs,
} from '../types.ts';

/** Per-session context (run() only receives the HarnessSession handle). */
interface SessionContext {
  cwd: string;
  configMode?: 'local-inherit' | 'managed';
  session: AgentSession | null;
  /** Resume failure (missing/corrupt session file) — surfaced as an error
   * event on the first run, never a silent fresh session. */
  failureMessage?: string;
  /** Set by interrupt()/stop() — an aborted prompt is not reported as error. */
  aborted: boolean;
  /** In-flight prompt handle of the current run (cleared in finally). */
  pendingPrompt: Promise<void> | null;
}

export class PiSdkDriver implements HarnessDriver {
  readonly harness = 'pi' as const;

  /** Context per live session object (WeakMap — no leaks, no key collisions
   * across concurrent sessions sharing this singleton driver). */
  private readonly contexts = new WeakMap<HarnessSession, SessionContext>();

  private assertLocalInherit(configMode?: 'local-inherit' | 'managed'): void {
    if (configMode === 'managed') {
      throw new Error(
        'pi harness supports local-inherit only in P0 (managed provider/model resolution is not implemented)'
      );
    }
  }

  /** Eager create: a real SDK session is materialized right away. */
  async create(args: HarnessCreateArgs): Promise<HarnessSession> {
    this.assertLocalInherit(args.configMode);
    const { session } = await createAgentSession({ cwd: args.workspaceRootPath });
    const sessionObj: HarnessSession = {
      nativeSessionId: session.sessionFile ?? session.sessionId,
      managed: true,
    };
    this.contexts.set(sessionObj, {
      cwd: args.workspaceRootPath,
      configMode: args.configMode,
      session,
      aborted: false,
      pendingPrompt: null,
    });
    return sessionObj;
  }

  /** Resume EXACTLY by the persisted session file. Missing/corrupt file →
   * explicit failure (surfaced as an error event on run), zero SDK calls. */
  async resume(args: HarnessResumeArgs): Promise<HarnessSession> {
    this.assertLocalInherit(args.configMode);
    const sessionObj: HarnessSession = {
      nativeSessionId: args.nativeSessionId,
      managed: true,
    };
    const ctx: SessionContext = {
      cwd: args.workspaceRootPath,
      configMode: args.configMode,
      session: null,
      aborted: false,
      pendingPrompt: null,
    };
    try {
      if (!existsSync(args.nativeSessionId)) {
        throw new Error(`pi session file not found: ${args.nativeSessionId}`);
      }
      const manager = SessionManager.open(args.nativeSessionId, undefined, args.workspaceRootPath);
      const { session } = await createAgentSession({ cwd: args.workspaceRootPath, sessionManager: manager });
      ctx.session = session;
    } catch (err) {
      // Gate B red line: never silently create a fresh session for a broken
      // resume — the first run() surfaces the explicit error and stops.
      ctx.failureMessage = err instanceof Error ? err.message : `pi resume failed: ${String(err)}`;
    }
    this.contexts.set(sessionObj, ctx);
    return sessionObj;
  }

  async *run(session: HarnessSession, message: string): AsyncIterable<HarnessEvent> {
    const ctx = this.contexts.get(session);
    if (!ctx) {
      yield { type: 'error', message: 'Pi SDK session not initialized' };
      return;
    }
    if (ctx.failureMessage) {
      yield { type: 'error', message: ctx.failureMessage };
      return;
    }
    if (!ctx.session) {
      yield { type: 'error', message: 'Pi SDK session unavailable' };
      return;
    }
    const agent = ctx.session;

    // Snapshot-and-reset the interrupt flag: only an interrupt issued DURING
    // this turn suppresses its error; a stale flag from a previous turn must
    // never swallow a real failure.
    const interrupted = ctx.aborted;
    ctx.aborted = false;

    // ---- Event pump (pi's subscribe is callback-based; claude's query is
    // natively async-iterable — this is the real difference between them).
    // Events are forwarded IMMEDIATELY as they arrive, never buffered until
    // the turn ends. ----
    const pending: AgentSessionEvent[] = [];
    let wakeupResolve: (() => void) | null = null;
    let poked = false;
    const poke = () => {
      if (wakeupResolve) {
        wakeupResolve();
        wakeupResolve = null;
      } else {
        poked = true;
      }
    };
    const unsubscribe = agent.subscribe((event) => {
      pending.push(event);
      poke();
    });

    // Object-property state: TS control-flow analysis ignores assignments
    // inside the .then closures, so a plain `let` would be narrowed to null.
    const promptState: { settled: boolean; error: Error | null } = { settled: false, error: null };
    const promptPromise = agent.prompt(message).then(
      () => {
        promptState.settled = true;
        poke(); // wake the pump — never deadlock on a settle with an empty queue
      },
      (err: Error) => {
        promptState.settled = true;
        promptState.error = err;
        poke();
      }
    );
    // Background handle — kept so a torn-down run can still be awaited by
    // callers; cleared in finally.
    ctx.pendingPrompt = promptPromise;

    try {
      let pendingText = '';
      while (true) {
        while (pending.length > 0) {
          const event = pending.shift()!;
          switch (event.type) {
            case 'message_update': {
              const e = event.assistantMessageEvent;
              if (e.type === 'text_delta') {
                pendingText += e.delta;
                yield { type: 'text_delta', text: e.delta };
              } else if (e.type === 'text_end') {
                // e.content is the FINAL text for this content index and
                // supersedes the accumulated deltas; the final draft is
                // emitted at the turn boundary (agent_end), same as the
                // claude driver's final-text semantics.
                pendingText = e.content;
              }
              break;
            }
            case 'tool_execution_start':
              yield {
                type: 'tool_start',
                toolName: event.toolName,
                toolUseId: event.toolCallId,
                input: (event.args ?? {}) as Record<string, unknown>,
              };
              break;
            case 'tool_execution_end':
              yield {
                type: 'tool_result',
                toolUseId: event.toolCallId,
                toolName: event.toolName,
                result:
                  typeof event.result === 'string'
                    ? event.result
                    : JSON.stringify(event.result ?? null),
                isError: event.isError === true,
              };
              break;
            case 'agent_end': {
              // Turn boundary: flush any remaining text as the final draft.
              if (pendingText.length > 0) {
                yield { type: 'text_complete', text: pendingText };
                pendingText = '';
              }
              yield { type: 'complete', usage: lastAssistantUsage(event.messages) };
              break;
            }
            default:
              break;
          }
        }
        if (promptState.settled) break;
        // Queue drained and the prompt is still in flight — wait for the next
        // poke (event arrival or prompt settle poke below).
        if (!poked) {
          await new Promise<void>((resolve) => {
            wakeupResolve = resolve;
          });
        } else {
          poked = false;
        }
      }

      // Prompt settled: flush remaining events was done above; report a real
      // (non-interrupt) failure as an explicit error event.
      if (promptState.error && !interrupted && !ctx.aborted) {
        yield {
          type: 'error',
          message: promptState.error instanceof Error
            ? promptState.error.message
            : `Pi prompt failed: ${String(promptState.error)}`,
        };
      }
    } finally {
      unsubscribe();
      ctx.pendingPrompt = null;
      // Reset the interrupt flag at turn end — a stale flag from this turn
      // must never be snapshotted as "interrupted" by the NEXT turn.
      ctx.aborted = false;
    }
  }

  /** interrupt = session.abort() (per-session handle — no cross-talk). */
  async interrupt(session: HarnessSession): Promise<void> {
    const ctx = this.contexts.get(session);
    if (!ctx?.session) return;
    ctx.aborted = true;
    try {
      await ctx.session.abort();
    } catch (err) {
      // abort() failure is best-effort — the turn will settle on its own.
    }
  }

  /** stop = abort (contexts are WeakMap-held). */
  async stop(session: HarnessSession): Promise<void> {
    const ctx = this.contexts.get(session);
    if (ctx?.session) {
      ctx.aborted = true;
      try {
        await ctx.session.abort();
      } catch {
        // best-effort
      }
    }
  }
}

/** Extract usage from the last assistant message (pi Usage → HarnessEvent). */
function lastAssistantUsage(
  messages: AgentMessage[]
): { inputTokens: number; outputTokens: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === 'assistant' && msg.usage) {
      return {
        inputTokens: msg.usage.input ?? 0,
        outputTokens: msg.usage.output ?? 0,
      };
    }
  }
  return undefined;
}
