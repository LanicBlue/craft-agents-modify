/**
 * PiSdkDriver tests (Issue #17 W6-1) — the pi coding agent SDK module is
 * mocked with controllable sessions/events; all other exports are provided
 * synchronously (re-export bindings are validated at link time, before any
 * async factory promise could resolve).
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mock the SDK module BEFORE importing the driver
// ---------------------------------------------------------------------------

type CreateCall = { options: Record<string, unknown> };
const createCalls: CreateCall[] = [];
const openCalls: Array<{ file: string; cwd?: string }> = [];
let promptBehavior:
  | { kind: 'resolve'; events: Array<{ type: string; [k: string]: unknown }>; messages: unknown[] }
  | { kind: 'reject'; error: Error }
  | { kind: 'hang' } = { kind: 'resolve', events: [], messages: [] };
const aborts: Array<{ sessionId: string }> = [];

class MockAgentSession {
  constructor(
    public sessionId: string,
    public sessionFile: string | undefined,
  ) {}
  private listeners: Array<(e: unknown) => void> = [];
  private hangRejects: Array<(err: Error) => void> = [];
  subscribe(listener: (e: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  async prompt(_message: string): Promise<void> {
    const behavior = promptBehavior;
    if (behavior.kind === 'hang') {
      // Simulates a real in-flight turn: settles only when abort() fires.
      await new Promise<void>((_, reject) => {
        this.hangRejects.push(reject);
      });
      return;
    }
    if (behavior.kind === 'reject') {
      throw behavior.error;
    }
    for (const e of behavior.events) {
      for (const l of this.listeners) l(e);
    }
  }
  async abort(): Promise<void> {
    aborts.push({ sessionId: this.sessionId });
    const rejects = this.hangRejects;
    this.hangRejects = [];
    for (const reject of rejects) reject(new Error('aborted'));
  }
}

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async (options: Record<string, unknown>) => {
    createCalls.push({ options });
    const file = typeof options.cwd === 'string' ? join(options.cwd as string, 'pi-session.jsonl') : undefined;
    return { session: new MockAgentSession(`pi-${createCalls.length}`, file) };
  },
  SessionManager: {
    open: (file: string, _sessionDir?: string, cwd?: string) => {
      openCalls.push({ file, cwd });
      return { opened: file };
    },
  },
}));

// ---------------------------------------------------------------------------

import { PiSdkDriver } from '../pi-sdk-driver.ts';
import type { HarnessSession } from '../../types.ts';

const BASE_ARGS = {
  workspaceRootPath: '/tmp/pi-ws',
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
  createCalls.length = 0;
  openCalls.length = 0;
  aborts.length = 0;
  promptBehavior = { kind: 'resolve', events: [], messages: [] };
});

describe('PiSdkDriver', () => {
  it('create is eager: one createAgentSession call, nativeSessionId = sessionFile', async () => {
    const driver = new PiSdkDriver();
    const session = await driver.create(BASE_ARGS);

    expect(createCalls.length).toBe(1);
    expect(session.nativeSessionId).toBe('/tmp/pi-ws/pi-session.jsonl');
    expect(session.managed).toBe(true);
  });

  it('local-inherit passes only cwd to createAgentSession (no model/systemPrompt)', async () => {
    const driver = new PiSdkDriver();
    await driver.create(BASE_ARGS);

    expect(createCalls[0]!.options).toEqual({ cwd: '/tmp/pi-ws' });
    expect('model' in createCalls[0]!.options).toBe(false);
    expect('systemPrompt' in createCalls[0]!.options).toBe(false);
  });

  it('managed mode throws a clear P0 error on create', async () => {
    const driver = new PiSdkDriver();
    await expect(
      driver.create({ ...BASE_ARGS, configMode: 'managed', systemPrompt: 'x', model: 'm' })
    ).rejects.toThrow(/local-inherit only in P0/);
    expect(createCalls.length).toBe(0);
  });

  it('run replays deltas → final text_complete → complete with usage', async () => {
    const driver = new PiSdkDriver();
    const session = await driver.create(BASE_ARGS);

    promptBehavior = {
      kind: 'resolve',
      events: [
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' },
        },
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' world' },
        },
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello world' },
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'tc-1',
          toolName: 'bash',
          args: { command: 'ls' },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tc-1',
          toolName: 'bash',
          result: 'ok',
          isError: false,
        },
        {
          type: 'agent_end',
          messages: [{ role: 'assistant', usage: { input: 10, output: 5, totalTokens: 15 } }],
        },
      ],
      messages: [],
    };

    const events = await collect(driver.run(session, 'hi'));
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'text_delta',
      'text_delta',
      'text_complete',
      'tool_start',
      'tool_result',
      'complete',
    ]);
    expect(events[2]).toEqual({ type: 'text_complete', text: 'Hello world' });
    expect(events[5]).toEqual({ type: 'complete', usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it('resume opens the exact session file; missing file → error event, zero retries, no new session', async () => {
    const driver = new PiSdkDriver();

    // Missing file: existsSync fails → failure recorded, no SDK session.
    const session = await driver.resume({
      ...BASE_ARGS,
      nativeSessionId: '/nonexistent/pi-session.jsonl',
    });
    const events = await collect(driver.run(session, 'continue'));
    expect(events).toEqual([
      { type: 'error', message: 'pi session file not found: /nonexistent/pi-session.jsonl' },
    ]);
    // Red line: createAgentSession was NEVER called for the broken resume.
    expect(createCalls.length).toBe(0);
    expect(openCalls.length).toBe(0);
  });

  it('resume with an existing file opens it via SessionManager.open and recreates the session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-driver-'));
    const file = join(dir, 'pi-session.jsonl');
    writeFileSync(file, '{}', 'utf-8');
    try {
      const driver = new PiSdkDriver();
      const session = await driver.resume({ ...BASE_ARGS, nativeSessionId: file });

      expect(openCalls).toEqual([{ file, cwd: '/tmp/pi-ws' }]);
      expect(createCalls.length).toBe(1);
      expect(createCalls[0]!.options.sessionManager).toEqual({ opened: file });
      expect(session.nativeSessionId).toBe(file);

      // And it runs normally on the resumed session (no failure surfaced).
      const events = await collect(driver.run(session, 'hi'));
      expect(events.some((e) => e.type === 'error')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('interrupt aborts only its own session (no cross-talk)', async () => {
    const driver = new PiSdkDriver();
    const sessionA = await driver.create(BASE_ARGS);
    const sessionB = await driver.create(BASE_ARGS);

    promptBehavior = { kind: 'hang' };
    const runA = driver.run(sessionA, 'first')[Symbol.asyncIterator]();
    const runB = driver.run(sessionB, 'second')[Symbol.asyncIterator]();
    const doneA = runA.next();
    const doneB = runB.next();
    await new Promise((r) => setTimeout(r, 10));

    await driver.interrupt(sessionA);

    expect(aborts).toEqual([{ sessionId: 'pi-1' }]);
    // A's run settles without an error event (user-initiated interrupt).
    const resultA = await doneA;
    expect(resultA.done).toBe(true);
    void doneB;
    await driver.stop(sessionB);
    expect(aborts).toEqual([{ sessionId: 'pi-1' }, { sessionId: 'pi-2' }]);
  });
});
