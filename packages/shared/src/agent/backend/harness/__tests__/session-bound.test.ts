/**
 * session_bound event tests (Issue #17 W5-1).
 *
 * Lazy-materializing drivers (SDK-based) cannot produce the native session id
 * at create() time — the real id only appears during the first run. The
 * backend must persist it via onSdkSessionIdUpdate so a restart resumes
 * instead of orphaning the native session. The event is idempotent (identical
 * ids never re-trigger the callback) and never forwarded downstream.
 */

import { describe, it, expect } from 'bun:test';
import { ExternalHarnessBackend } from '../external-harness-backend.ts';
import type { ExternalHarnessBackendConfig } from '../external-harness-backend.ts';
import type {
  HarnessDriver,
  HarnessEvent,
  HarnessSession,
  HarnessCreateArgs,
  HarnessResumeArgs,
} from '../types.ts';

/** Stub driver: create() returns an EMPTY native id (lazy materialization);
 * run() reports the real id via session_bound on the first call only. */
class LazyStubDriver implements HarnessDriver {
  readonly harness = 'claude' as const;
  createCalls = 0;
  resumeCalls: string[] = [];
  private firstRun = true;

  async create(_args: HarnessCreateArgs): Promise<HarnessSession> {
    this.createCalls += 1;
    return { nativeSessionId: '', managed: true };
  }

  async resume(args: HarnessResumeArgs): Promise<HarnessSession> {
    this.resumeCalls.push(args.nativeSessionId);
    return { nativeSessionId: args.nativeSessionId, managed: true };
  }

  async *run(session: HarnessSession, _message: string): AsyncIterable<HarnessEvent> {
    if (this.firstRun) {
      this.firstRun = false;
      yield { type: 'session_bound', nativeSessionId: 'sdk-session-42' };
    }
    yield { type: 'text_delta', text: 'hi' };
    yield { type: 'text_complete', text: 'hi' };
    yield { type: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
  }

  async stop(): Promise<void> {}
}

function makeConfig(driver: HarnessDriver, updates: Partial<ExternalHarnessBackendConfig> = {}) {
  return {
    workspace: { id: 'ws-1', name: 'WS', rootPath: '/tmp/ws', createdAt: 1 },
    session: {
      id: 'sess-1',
      workspaceRootPath: '/tmp/ws',
      sdkSessionId: undefined as string | undefined,
      createdAt: 1,
      lastUsedAt: 1,
      permissionMode: 'ask',
      agentId: 'agent-1',
    },
    provider: 'anthropic',
    model: 'gpt-5',
    thinkingLevel: 'medium',
    harness: 'claude',
    driver,
    systemPrompt: 'You are the lazy agent.',
    skipConfigWatcher: true,
    ...updates,
  } as unknown as ExternalHarnessBackendConfig;
}

describe('session_bound (lazy native session materialization)', () => {
  it('persists the bound id via onSdkSessionIdUpdate and does not forward the event', async () => {
    const driver = new LazyStubDriver();
    const updates: string[] = [];
    const backend = new ExternalHarnessBackend(
      makeConfig(driver, { onSdkSessionIdUpdate: (id) => updates.push(id) })
    );

    await backend.postInit();
    expect(driver.createCalls).toBe(1);
    // postInit persists the (empty) create-time id — existing behavior.
    expect(updates).toEqual(['']);

    const events: string[] = [];
    for await (const e of backend.chat('hello')) {
      events.push(e.type);
    }

    // Bound id persisted exactly once; the session_bound event itself is
    // never forwarded downstream.
    expect(updates).toEqual(['', 'sdk-session-42']);
    expect(events).toEqual(['text_delta', 'text_complete', 'complete']);
  });

  it('does not re-trigger the callback when the id is unchanged on later runs', async () => {
    const driver = new LazyStubDriver();
    const updates: string[] = [];
    const backend = new ExternalHarnessBackend(
      makeConfig(driver, { onSdkSessionIdUpdate: (id) => updates.push(id) })
    );

    await backend.postInit();
    await backend.chat('first').next();
    await backend.chat('second').next();

    expect(updates).toEqual(['', 'sdk-session-42']);
  });

  it('a restarted backend resumes with the bound id (no orphaned session)', async () => {
    const driver = new LazyStubDriver();
    const first = new ExternalHarnessBackend(makeConfig(driver));
    await first.postInit();
    await first.chat('first').next();

    // Restart: the persisted id feeds resume() instead of create().
    const restarted = new ExternalHarnessBackend(
      makeConfig(driver, {
        session: { ...makeConfig(driver).session!, sdkSessionId: 'sdk-session-42' },
      })
    );
    await restarted.postInit();

    expect(driver.createCalls).toBe(1);
    expect(driver.resumeCalls).toEqual(['sdk-session-42']);
  });
});
