/**
 * Gate B real-dispatch integration test (Issues #4/#9/#10).
 *
 * Runs the REAL SessionManager.sendMessage chain end-to-end against a mock
 * Codex CLI subprocess (real child process speaking the documented JSONL
 * protocol contract):
 *
 *   dispatch → sendMessage → getOrCreateAgent (external-harness early dispatch)
 *   → loadLatestRevision (real registry) → getHarnessDriver (registry)
 *   → createExternalHarnessBackend (real backend) → postInit
 *   → CodexDriver.create/resume (real spawn + ready handshake)
 *   → chatImpl → driver.run (real JSONL streaming) → event processing
 *   → session persistence on disk
 *
 * The mock records whether it was init'ed in create or resume mode and echoes
 * the mode in its reply text, so the resume path is verified through the
 * observable behavior rather than internal state.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionManager, createManagedSession } from './SessionManager.ts';
import { createAgent, updateAgent } from '@craft-agent/shared/agents';
import { ensureAgentSession } from '@craft-agent/shared/agents';
import { loadSession, sessionPersistenceQueue } from '@craft-agent/shared/sessions';
import { CodexDriver } from '@craft-agent/shared/agent/backend/harness/drivers/codex-driver';
import { registerHarnessDriver } from '@craft-agent/shared/agent/backend/harness/registry';

// Mock Codex CLI: records init mode (new vs resume) and echoes it — plus a
// summary of the systemPrompt received — in the reply text, so BOTH the
// resume path and the #3 stored-snapshot contract are verified through
// observable behavior rather than internal state.
const MOCK_SOURCE = `
let mode = 'new';
let promptMarker = '';
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
      promptMarker = (msg.systemPrompt || '').split(' ').slice(0, 5).join(' ');
      process.stdout.write(JSON.stringify({ type: 'ready', sessionId: msg.nativeSessionId || ('mock-codex-' + Date.now()) }) + '\\n');
      break;
    case 'message':
      process.stdout.write(JSON.stringify({ type: 'text_delta', text: 'Hello' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'text_complete', text: 'Hello world (' + mode + ' | ' + promptMarker + ')' }) + '\\n');
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

function makeWorkspace() {
  return {
    id: 'ws_gate_b',
    name: 'Gate B Workspace',
    rootPath: wsRoot,
    createdAt: Date.now(),
  };
}

/** Seed a SessionManager with the real on-disk session from ensureAgentSession. */
function seedSession(sm: SessionManager, sessionId: string, name: string) {
  const workspace = makeWorkspace();
  const stored = loadSession(wsRoot, sessionId);
  expect(stored).not.toBeNull();
  const managed = createManagedSession(
    {
      id: sessionId,
      name,
      agentId: stored!.agentId,
      agentProfileSnapshot: stored!.agentProfileSnapshot,
      sdkSessionId: stored!.sdkSessionId,
      permissionMode: stored!.permissionMode ?? 'allow-all',
      thinkingLevel: stored!.thinkingLevel,
    },
    workspace as never,
    { messagesLoaded: true },
  );
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed);
  return managed;
}

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'gate-b-config-'));
  process.env.CRAFT_CONFIG_DIR = configDir;
  wsRoot = mkdtempSync(join(tmpdir(), 'gate-b-ws-'));
  const mockDir = mkdtempSync(join(tmpdir(), 'gate-b-mock-'));
  mockPath = join(mockDir, 'mock-codex.cjs');
  writeFileSync(mockPath, MOCK_SOURCE);

  // Register the codex driver against the mock subprocess (overrides default).
  registerHarnessDriver(
    new CodexDriver({ command: 'node', args: [mockPath], readyTimeoutMs: 5000 })
  );
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(wsRoot, { recursive: true, force: true });
  delete process.env.CRAFT_CONFIG_DIR;
});

describe('Gate B: real dispatch through external-harness backend', () => {
  it('materializes a session and completes a real dispatch round-trip', async () => {
    // 1. Real agent registry + real canonical binding + real session on disk.
    const agent = createAgent({
      id: 'gate-b-codex',
      name: 'Gate B Codex Agent',
      execution: { kind: 'external-harness', harness: 'codex' },
      systemPrompt: 'You are the gate B agent.',
    });
    const session = await ensureAgentSession(wsRoot, 'ws_gate_b', agent.id);
    expect(session.agentId).toBe(agent.id);
    expect(session.agentProfileSnapshot?.execution.kind).toBe('external-harness');

    // 2. Real SessionManager with the real session seeded (no mocks in the chain).
    const sm = new SessionManager();
    const managed = seedSession(sm, session.id, 'gate-b-dispatch');
    const agentRef = () =>
      (managed as unknown as { agent: { destroy(): void } | null }).agent;

    try {
      await sm.sendMessage(session.id, 'hello from gate b');
      await sessionPersistenceQueue.flush(session.id);

      // 3. Verify persisted conversation on disk.
      const after = loadSession(wsRoot, session.id);
      expect(after).not.toBeNull();
      const texts = after!.messages.map((m) => m.content ?? '');
      expect(texts.some((t) => t.includes('hello from gate b'))).toBe(true);
      expect(texts.some((t) => t.includes('Hello world (new |'))).toBe(true);

      // 4. Native session id persisted via onSdkSessionIdUpdate (create mode).
      expect(after!.sdkSessionId).toMatch(/^mock-codex-/);

      // 5. Second dispatch on the same manager reuses the same backend instance.
      await sm.sendMessage(session.id, 'second message');
      await sessionPersistenceQueue.flush(session.id);
      const after2 = loadSession(wsRoot, session.id);
      expect(after2!.messages.length).toBeGreaterThan(after!.messages.length);
      expect(after2!.sdkSessionId).toBe(after!.sdkSessionId);
    } finally {
      agentRef()?.destroy();
    }
  });

  it('restart recovery: fresh SessionManager resumes the native harness session', async () => {
    const agent = createAgent({
      id: 'gate-b-resume',
      name: 'Gate B Resume Agent',
      execution: { kind: 'external-harness', harness: 'codex' },
      systemPrompt: 'You are the resume agent.',
    });
    const session = await ensureAgentSession(wsRoot, 'ws_gate_b', agent.id);

    // First incarnation: creates the native session (mode: new).
    const sm1 = new SessionManager();
    const managed1 = seedSession(sm1, session.id, 'gate-b-restart-1');
    try {
      await sm1.sendMessage(session.id, 'first turn');
      await sessionPersistenceQueue.flush(session.id);
      const first = loadSession(wsRoot, session.id);
      expect(first!.sdkSessionId).toMatch(/^mock-codex-/);
    } finally {
      (managed1 as unknown as { agent: { destroy(): void } | null }).agent?.destroy();
    }

    // Second incarnation: no in-memory agent — postInit must RESUME
    // (mock echoes init mode; reply text proves the resume path ran).
    const sm2 = new SessionManager();
    const managed2 = seedSession(sm2, session.id, 'gate-b-restart-2');
    try {
      await sm2.sendMessage(session.id, 'turn after restart');
      await sessionPersistenceQueue.flush(session.id);
      const second = loadSession(wsRoot, session.id);
      const texts = second!.messages.map((m) => m.content ?? '');
      expect(texts.some((t) => t.includes('Hello world (resume |'))).toBe(true);
      // Same logical session — binding not replaced.
      expect(second!.id).toBe(session.id);
      expect(second!.sdkSessionId).toBe(loadSession(wsRoot, session.id)!.sdkSessionId);
    } finally {
      (managed2 as unknown as { agent: { destroy(): void } | null }).agent?.destroy();
    }
  });

  it('uses the stored snapshot prompt, never the latest revision (#3)', async () => {
    const agent = createAgent({
      id: 'gate-b-snapshot',
      name: 'Gate B Snapshot Agent',
      execution: { kind: 'external-harness', harness: 'codex' },
      systemPrompt: 'You are the prompt-A agent.',
    });
    const session = await ensureAgentSession(wsRoot, 'ws_gate_b', agent.id);

    // First dispatch: reply must echo the snapshot prompt (prompt-A).
    const sm = new SessionManager();
    const managed = seedSession(sm, session.id, 'gate-b-prompt-1');
    try {
      await sm.sendMessage(session.id, 'first turn');
      await sessionPersistenceQueue.flush(session.id);
      const texts = loadSession(wsRoot, session.id)!.messages.map((m) => m.content ?? '');
      expect(texts.some((t) => t.includes('| You are the prompt-A agent.'))).toBe(true);
    } finally {
      (managed as unknown as { agent: { destroy(): void } | null }).agent?.destroy();
    }

    // Agent prompt updated to B (rev 2) — the stored snapshot must still win.
    const updated = updateAgent(agent.id, { systemPrompt: 'You are the prompt-B agent.' });
    expect(updated.latestProfileRevision).toBe(2);

    // Same manager, second dispatch: still prompt-A, never prompt-B.
    const managed2 = seedSession(sm, session.id, 'gate-b-prompt-2');
    try {
      await sm.sendMessage(session.id, 'second turn');
      await sessionPersistenceQueue.flush(session.id);
      const after = loadSession(wsRoot, session.id)!;
      const texts = after.messages.map((m) => m.content ?? '');
      expect(texts.some((t) => t.includes('| You are the prompt-A agent.'))).toBe(true);
      expect(texts.some((t) => t.includes('prompt-B'))).toBe(false);
    } finally {
      (managed2 as unknown as { agent: { destroy(): void } | null }).agent?.destroy();
    }

    // Fresh SessionManager (restart): resume dispatch must still use prompt-A.
    const sm3 = new SessionManager();
    const managed3 = seedSession(sm3, session.id, 'gate-b-prompt-3');
    try {
      await sm3.sendMessage(session.id, 'turn after restart');
      await sessionPersistenceQueue.flush(session.id);
      const after = loadSession(wsRoot, session.id)!;
      const texts = after.messages.map((m) => m.content ?? '');
      expect(texts.some((t) => t.includes('| You are the prompt-A agent.'))).toBe(true);
      expect(texts.some((t) => t.includes('prompt-B'))).toBe(false);
    } finally {
      (managed3 as unknown as { agent: { destroy(): void } | null }).agent?.destroy();
    }
  });

  it('rejects a corrupt session (agentId without snapshot) explicitly (#3)', async () => {
    const agent = createAgent({
      id: 'gate-b-corrupt',
      name: 'Gate B Corrupt Agent',
      execution: { kind: 'external-harness', harness: 'codex' },
      systemPrompt: 'You are the corrupt agent.',
    });
    const session = await ensureAgentSession(wsRoot, 'ws_gate_b', agent.id);

    // Strip the snapshot from the persisted session header (keep agentId).
    const sessionPath = join(
      wsRoot,
      '.craft-agent',
      'sessions',
      session.id,
      'session.jsonl',
    );
    const raw = readFileSync(sessionPath, 'utf-8');
    const lines = raw.split('\n');
    const header = JSON.parse(lines[0]!);
    delete header.agentProfileSnapshot;
    writeFileSync(sessionPath, JSON.stringify(header) + '\n' + lines.slice(1).join('\n'), 'utf-8');

    const sm = new SessionManager();
    const managed = seedSession(sm, session.id, 'gate-b-corrupt');
    expect(managed.agentProfileSnapshot).toBeUndefined();
    try {
      await expect(sm.sendMessage(session.id, 'hello')).rejects.toThrow(
        /corrupt agent session .* manual resolution/
      );
    } finally {
      (managed as unknown as { agent: { destroy(): void } | null }).agent?.destroy();
    }

    // No new native context was created: no SDK session id, no assistant text.
    const after = loadSession(wsRoot, session.id)!;
    expect(after.sdkSessionId).toBeUndefined();
    const texts = after.messages.map((m) => m.content ?? '');
    expect(texts.some((t) => t.includes('Hello world'))).toBe(false);
  });
});
