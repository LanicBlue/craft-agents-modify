/**
 * adoptPersistedSession integration tests (rework Step 1, audit gap).
 *
 * Proves SessionManager can consume sessions materialized by
 * ensureAgentSession WITHOUT manual seeding or a full reload:
 *
 *   ensureAgentSession (shared, real) → adoptPersistedSession (SM) →
 *   sendMessage end-to-end (real external-harness dispatch via mock Codex).
 *
 * Unlike gate-b-harness-dispatch.test.ts, sessions are NEVER manually
 * inserted into the SM in-memory map — adoption is the only path in.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionManager } from './SessionManager.ts';
import { createAgent, ensureAgentSession } from '@craft-agent/shared/agents';
import { loadSession, sessionPersistenceQueue } from '@craft-agent/shared/sessions';
import { CodexDriver } from '@craft-agent/shared/agent/backend/harness/drivers/codex-driver';
import { registerHarnessDriver } from '@craft-agent/shared/agent/backend/harness/registry';
import type { Workspace } from '@craft-agent/shared/config';

// Mock Codex CLI: records init mode (new vs resume) and echoes it in replies.
const MOCK_SOURCE = `
let mode = 'new';
process.stdin.resume();
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
function handle(msg) {
  switch (msg.type) {
    case 'init':
      mode = msg.nativeSessionId ? 'resume' : 'new';
      process.stdout.write(JSON.stringify({ type: 'ready', sessionId: msg.nativeSessionId || ('mock-codex-' + Date.now()) }) + '\\n');
      break;
    case 'message':
      process.stdout.write(JSON.stringify({ type: 'text_delta', text: 'Hello' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'text_complete', text: 'Hello world (' + mode + ')' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }) + '\\n');
      break;
    case 'shutdown':
      process.exit(0);
      break;
  }
}
`;

let configDir: string;
let wsRoot: string;
let mockPath: string;

const workspace: Workspace = {
  id: 'ws_adopt',
  name: 'Adopt Workspace',
  slug: 'adopt-workspace',
  rootPath: '',
  createdAt: Date.now(),
};

function makeAgent(name: string) {
  return createAgent({
    name,
    execution: { kind: 'external-harness', harness: 'codex' },
    systemPrompt: 'You are the adopt agent.',
  });
}

function agentRef(managed: { agent: unknown } | null) {
  return (managed as unknown as { agent: { destroy(): void } | null } | null)?.agent ?? null;
}

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'adopt-config-'));
  process.env.CRAFT_CONFIG_DIR = configDir;
  wsRoot = mkdtempSync(join(tmpdir(), 'adopt-ws-'));
  workspace.rootPath = wsRoot;
  const mockDir = mkdtempSync(join(tmpdir(), 'adopt-mock-'));
  mockPath = join(mockDir, 'mock-codex.cjs');
  writeFileSync(mockPath, MOCK_SOURCE);

  registerHarnessDriver(
    new CodexDriver({ command: 'node', args: [mockPath], readyTimeoutMs: 5000 })
  );
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(wsRoot, { recursive: true, force: true });
  delete process.env.CRAFT_CONFIG_DIR;
});

describe('adoptPersistedSession', () => {
  it('first dispatch succeeds end-to-end without any pre-registration', async () => {
    const agent = makeAgent('Adopt Dispatch Agent');
    const session = await ensureAgentSession(wsRoot, workspace.id, agent.id);

    const sm = new SessionManager();
    const managed = sm.adoptPersistedSession(workspace, session.id);
    expect(managed).not.toBeNull();
    expect(managed!.id).toBe(session.id);

    try {
      await sm.sendMessage(session.id, 'hello from adopt');
      await sessionPersistenceQueue.flush(session.id);

      const after = loadSession(wsRoot, session.id);
      expect(after).not.toBeNull();
      const texts = after!.messages.map((m) => m.content ?? '');
      expect(texts.some((t) => t.includes('hello from adopt'))).toBe(true);
      expect(texts.some((t) => t.includes('Hello world (new)'))).toBe(true);
      expect(after!.sdkSessionId).toMatch(/^mock-codex-/);
    } finally {
      agentRef(managed)?.destroy();
    }
  });

  it('is idempotent — second adopt returns the same managed instance', async () => {
    const agent = makeAgent('Adopt Idempotent Agent');
    const session = await ensureAgentSession(wsRoot, workspace.id, agent.id);

    const sm = new SessionManager();
    const first = sm.adoptPersistedSession(workspace, session.id);
    const second = sm.adoptPersistedSession(workspace, session.id);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('returns null for a session that does not exist on disk', async () => {
    const sm = new SessionManager();
    expect(sm.adoptPersistedSession(workspace, 'no-such-session')).toBeNull();
  });

  it('restart recovery: fresh SessionManager adopts and resumes the native harness session', async () => {
    const agent = makeAgent('Adopt Resume Agent');
    const session = await ensureAgentSession(wsRoot, workspace.id, agent.id);

    // First incarnation: creates the native session (mode: new).
    const sm1 = new SessionManager();
    const managed1 = sm1.adoptPersistedSession(workspace, session.id);
    try {
      await sm1.sendMessage(session.id, 'first turn');
      await sessionPersistenceQueue.flush(session.id);
      const first = loadSession(wsRoot, session.id);
      expect(first!.sdkSessionId).toMatch(/^mock-codex-/);
    } finally {
      agentRef(managed1)?.destroy();
    }

    // Second incarnation: no in-memory agent — postInit must RESUME
    // (mock echoes init mode; reply text proves the resume path ran).
    const sm2 = new SessionManager();
    const managed2 = sm2.adoptPersistedSession(workspace, session.id);
    try {
      await sm2.sendMessage(session.id, 'turn after restart');
      await sessionPersistenceQueue.flush(session.id);
      const second = loadSession(wsRoot, session.id);
      const texts = second!.messages.map((m) => m.content ?? '');
      expect(texts.some((t) => t.includes('Hello world (resume)'))).toBe(true);
      expect(second!.id).toBe(session.id);
    } finally {
      agentRef(managed2)?.destroy();
    }
  });
});
