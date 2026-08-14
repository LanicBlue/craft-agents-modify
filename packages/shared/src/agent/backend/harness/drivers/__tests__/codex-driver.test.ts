/**
 * CodexDriver Gate B validation tests (Issue #10 Step 3)
 *
 * Uses a mock Codex subprocess (plain Node script written to a temp dir)
 * that speaks the JSONL protocol contract:
 * - init → ready (sessionId: mock-codex-<ts>)
 * - message → text_delta + text_complete + done (with usage)
 * - interrupt → done
 * - shutdown → exit(0)
 * Env-controlled variants: MOCK_CRASH=1 (exit(1) on first message),
 * MOCK_HANG=1 (never respond to init), MOCK_DELAY_MS (delay message reply
 * so interrupt can land mid-turn).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexDriver } from '../codex-driver.ts';

const MOCK_SOURCE = `
process.stdin.resume();
let buffer = '';
let interrupted = false;
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    handle(JSON.parse(line));
  }
});
function handle(msg) {
  switch (msg.type) {
    case 'init':
      if (process.env.MOCK_HANG === '1') return;
      process.stdout.write(JSON.stringify({ type: 'ready', sessionId: msg.nativeSessionId || 'mock-codex-' + Date.now() }) + '\\n');
      break;
    case 'message':
      if (process.env.MOCK_CRASH === '1') { process.exit(1); return; }
      const reply = () => {
        if (interrupted) return;
        process.stdout.write(JSON.stringify({ type: 'text_delta', text: 'Hello' }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'text_complete', text: 'Hello world' }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }) + '\\n');
      };
      if (process.env.MOCK_DELAY_MS) { setTimeout(reply, Number(process.env.MOCK_DELAY_MS)); }
      else { reply(); }
      break;
    case 'interrupt':
      interrupted = true;
      process.stdout.write(JSON.stringify({ type: 'done' }) + '\\n');
      break;
    case 'shutdown':
      process.exit(0);
      break;
  }
}
`;

const mockDir = mkdtempSync(join(tmpdir(), 'codex-mock-'));
const mockPath = join(mockDir, 'mock-codex.cjs');
writeFileSync(mockPath, MOCK_SOURCE);

afterAll(() => {
  rmSync(mockDir, { recursive: true, force: true });
});

const baseArgs = {
  workspaceRootPath: mockDir,
  systemPrompt: 'You are a test harness.',
  model: 'gpt-5-codex',
};

const makeDriver = (env?: Record<string, string>, readyTimeoutMs = 2000) =>
  new CodexDriver({ command: 'node', args: [mockPath], env, readyTimeoutMs });

describe('CodexDriver (mock subprocess)', () => {
  test('create() spawns the mock and receives the native session id from the ready handshake', async () => {
    const driver = makeDriver();
    const session = await driver.create(baseArgs);
    expect(session.nativeSessionId).toMatch(/^mock-codex-/);
    expect(session.managed).toBe(true);
    await driver.stop(session);
  });

  test('resume() spawns the mock with the existing session id', async () => {
    const driver = makeDriver();
    const session = await driver.resume({ ...baseArgs, nativeSessionId: 'mock-codex-999' });
    expect(session.nativeSessionId).toBe('mock-codex-999');
    await driver.stop(session);
  });

  test('run() streams text_delta → text_complete → complete', async () => {
    const driver = makeDriver();
    const session = await driver.create(baseArgs);
    const events: string[] = [];
    for await (const event of driver.run(session, 'hi')) events.push(event.type);
    expect(events).toEqual(['text_delta', 'text_complete', 'complete']);
    await driver.stop(session);
  });

  test('interrupt() interrupts a mid-turn run; mock acknowledges with done', async () => {
    const driver = makeDriver({ MOCK_DELAY_MS: '300' });
    const session = await driver.create(baseArgs);
    const events: string[] = [];
    const consume = (async () => {
      for await (const event of driver.run(session, 'slow')) events.push(event.type);
    })();
    await new Promise((resolve) => setTimeout(resolve, 100)); // turn in flight (message sent synchronously)
    await driver.interrupt(session);
    await consume;
    expect(events).toEqual(['complete']);
    await driver.stop(session);
  });

  test('stop() shuts the mock down cleanly (no signal escalation)', async () => {
    const driver = makeDriver();
    const session = await driver.create(baseArgs);
    const t0 = Date.now();
    await driver.stop(session);
    expect(Date.now() - t0).toBeLessThan(1500);
    // Process is gone: a subsequent run reports the dead process.
    const events: string[] = [];
    for await (const event of driver.run(session, 'again')) events.push(event.type);
    expect(events).toEqual(['error', 'complete']);
  });

  test('crash during run emits error then complete', async () => {
    const driver = makeDriver({ MOCK_CRASH: '1' });
    const session = await driver.create(baseArgs);
    const events: { type: string; message?: string }[] = [];
    for await (const event of driver.run(session, 'hi')) events.push(event);
    expect(events.map((e) => e.type)).toEqual(['error', 'complete']);
    expect(events[0]?.message).toBe('Codex process exited unexpectedly');
  });

  test('ENOENT command rejects with the CLI-not-found error', async () => {
    const driver = new CodexDriver({
      command: 'definitely-not-a-real-command-xyz',
      readyTimeoutMs: 2000,
    });
    await expect(driver.create(baseArgs)).rejects.toThrow(
      "Codex CLI not found. Install 'codex' or configure command path."
    );
  });

  test('ready timeout rejects with the timeout error', async () => {
    const driver = makeDriver({ MOCK_HANG: '1' }, 250);
    const t0 = Date.now();
    await expect(driver.create(baseArgs)).rejects.toThrow(
      'Codex did not become ready within 250ms'
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
  });

  test('concurrent dispatch: second run() is rejected with already-active error', async () => {
    const driver = makeDriver();
    const session = await driver.create(baseArgs);
    const first = driver.run(session, 'first');
    const firstNext = first.next(); // start the turn (activeRun set synchronously; first event arrives later)
    const secondEvents: string[] = [];
    for await (const event of driver.run(session, 'second')) secondEvents.push(event.type);
    expect(secondEvents).toEqual(['error', 'complete']);
    // First turn still streams normally afterwards (text_delta went to firstNext).
    const rest: string[] = [];
    for await (const event of first) rest.push(event.type);
    await firstNext;
    expect(rest).toEqual(['text_complete', 'complete']);
    await driver.stop(session);
  });
});
