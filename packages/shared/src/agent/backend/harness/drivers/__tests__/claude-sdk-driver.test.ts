/**
 * ClaudeSdkDriver tests (Issue #17 W5-2) — the SDK module is mocked with a
 * controllable query() async generator; all other real exports are spread
 * through (synchronous factory required — re-export bindings are validated at
 * link time, before any async factory promise could resolve).
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock the SDK module BEFORE importing the driver
// ---------------------------------------------------------------------------

type QueryCall = {
  prompt: string;
  options: {
    cwd?: string;
    resume?: string;
    systemPrompt?: string;
    model?: string;
    abortController?: AbortController;
    includePartialMessages?: boolean;
  };
};

const queryCalls: QueryCall[] = [];
let streamMessages: unknown[] = [];
let interruptImpl: (() => Promise<unknown>) | null = null;
let queryImpl:
  | ((params: { prompt: string; options: unknown }) => AsyncIterable<unknown> & { interrupt?: () => Promise<unknown> })
  | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: string; options: unknown }) => {
    queryCalls.push(params as QueryCall);
    if (queryImpl) return queryImpl(params as { prompt: string; options: unknown });
    const gen = (async function* () {
      for (const m of streamMessages) yield m;
    })();
    if (interruptImpl) {
      (gen as unknown as { interrupt: () => Promise<unknown> }).interrupt = interruptImpl;
    }
    return gen;
  },
}));

// ---------------------------------------------------------------------------

import { ClaudeSdkDriver } from '../claude-sdk-driver.ts';
import type { HarnessSession } from '../../types.ts';

const BASE_ARGS = {
  workspaceRootPath: '/tmp/ws',
  configMode: 'local-inherit' as const,
};

function collect(events: AsyncIterable<{ type: string }>) {
  return (async () => {
    const out: Array<{ type: string; [k: string]: unknown }> = [];
    for await (const e of events) out.push(e as { type: string; [k: string]: unknown });
    return out;
  })();
}

beforeEach(() => {
  queryCalls.length = 0;
  streamMessages = [];
  interruptImpl = null;
  queryImpl = null;
});

describe('ClaudeSdkDriver', () => {
  it('create is lazy: empty native id, zero SDK calls', async () => {
    const driver = new ClaudeSdkDriver();
    const session = await driver.create(BASE_ARGS);

    expect(session.nativeSessionId).toBe('');
    expect(session.managed).toBe(true);
    expect(queryCalls.length).toBe(0);
  });

  it('first run binds the session id, then streams text/complete; local-inherit omits profile options', async () => {
    const driver = new ClaudeSdkDriver();
    const session = await driver.create(BASE_ARGS);

    streamMessages = [
      { type: 'system', subtype: 'init', session_id: 'sdk-session-1', tools: [] },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: { content: [{ type: 'text', text: 'hello there' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-session-1',
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 5 },
        errors: [],
      },
    ];

    const events = await collect(driver.run(session, 'hi'));
    const types = events.map((e) => e.type);
    // session_bound precedes the user-visible stream.
    expect(types.indexOf('session_bound')).toBe(0);
    expect(events[0]).toEqual({ type: 'session_bound', nativeSessionId: 'sdk-session-1' });
    expect(types).toContain('text_delta');
    expect(types).toContain('complete');

    // local-inherit: no systemPrompt/model in the SDK options.
    expect(queryCalls.length).toBe(1);
    expect(queryCalls[0]!.options.cwd).toBe('/tmp/ws');
    expect(queryCalls[0]!.options.systemPrompt).toBeUndefined();
    expect(queryCalls[0]!.options.model).toBeUndefined();
    expect(queryCalls[0]!.options.resume).toBeUndefined();
  });

  it('managed mode passes systemPrompt and model to the SDK options', async () => {
    const driver = new ClaudeSdkDriver();
    const session = await driver.create({
      ...BASE_ARGS,
      configMode: 'managed',
      systemPrompt: 'You are the managed agent.',
      model: 'claude-opus-4-8',
    });

    streamMessages = [
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-m',
        is_error: false,
        usage: { input_tokens: 1, output_tokens: 1 },
        errors: [],
      },
    ];
    await collect(driver.run(session, 'go'));

    expect(queryCalls[0]!.options.systemPrompt).toBe('You are the managed agent.');
    expect(queryCalls[0]!.options.model).toBe('claude-opus-4-8');
  });

  it('resume passes options.resume; a failed resume terminates with an error, no new id, no retry', async () => {
    const driver = new ClaudeSdkDriver();
    const session = await driver.resume({ ...BASE_ARGS, nativeSessionId: 'sdk-existing' });

    // Resume fails: SDK emits an error result. No session_id anywhere, so no
    // session_bound; the stream ends with an explicit error event.
    streamMessages = [
      {
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'sdk-existing',
        is_error: true,
        usage: { input_tokens: 1, output_tokens: 1 },
        errors: ['resume failed: session gone'],
      },
    ];

    const events = await collect(driver.run(session, 'continue'));

    expect(queryCalls[0]!.options.resume).toBe('sdk-existing');
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(events[0]).toEqual({
      type: 'error',
      message: 'Claude session failed: resume failed: session gone',
    });
    // No retry — exactly one query call.
    expect(queryCalls.length).toBe(1);
  });

  it('interrupt aborts the in-flight query (SDK interrupt when available)', async () => {
    const driver = new ClaudeSdkDriver();
    const session = await driver.create(BASE_ARGS);

    let interrupted = false;
    interruptImpl = async () => {
      interrupted = true;
    };

    streamMessages = [
      { type: 'system', subtype: 'init', session_id: 'sdk-i', tools: [] },
      { type: 'stream_event', session_id: 'sdk-i', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } },
    ];

    const iterator = driver.run(session, 'hi')[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value.type).toBe('session_bound');

    await driver.interrupt(session);
    expect(interrupted).toBe(true);
  });

  it('interrupt falls back to aborting the controller', async () => {
    const driver = new ClaudeSdkDriver();
    const session = await driver.create(BASE_ARGS);

    streamMessages = [
      { type: 'system', subtype: 'init', session_id: 'sdk-a', tools: [] },
    ];

    const iterator = driver.run(session, 'hi')[Symbol.asyncIterator]();
    await iterator.next();

    await driver.interrupt(session);
    // No exception, and the in-flight stream is cancelled via the controller.
    expect(queryCalls[0]!.options.abortController).toBeInstanceOf(AbortController);
    expect(queryCalls[0]!.options.abortController!.signal.aborted).toBe(true);
  });
});
