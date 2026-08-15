/**
 * Claude SDK REAL Gate B (Issue #17 W5-3) — env-gated integration test.
 *
 * Unlike every other harness test, NOTHING is mocked here: the real
 * @anthropic-ai/claude-agent-sdk runs against the user's LOCAL native Claude
 * configuration (configMode 'local-inherit' — SDK default OAuth path).
 *
 * Gate: CRAFT_CLAUDE_SDK_E2E=1 — skipped by default (CI/regular regression
 * never touches the network or the user's Claude account).
 *
 * Verifies the full #17 promise on a real machine:
 *   createAgent (external-harness/claude) → ensureAgentSession → adopt →
 *   sendMessage (real SDK query) → session_bound persists the native id →
 *   restart → resume keeps the SAME native session (no fork).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionManager } from './SessionManager.ts';
import { createAgent, ensureAgentSession } from '@craft-agent/shared/agents';
import { loadSession, sessionPersistenceQueue } from '@craft-agent/shared/sessions';
import { ClaudeSdkDriver } from '@craft-agent/shared/agent/backend/harness/drivers';
import { registerHarnessDriver } from '@craft-agent/shared/agent/backend/harness/registry';
import type { Workspace } from '@craft-agent/shared/config';

// Env gate: only runs when explicitly enabled on a machine with a logged-in
// native Claude CLI configuration.
const E2E = process.env.CRAFT_CLAUDE_SDK_E2E === '1';
const describeE2E = E2E ? describe : describe.skip;

let configDir: string;
let wsRoot: string;

const workspace: Workspace = {
  id: 'ws_claude_sdk',
  name: 'Claude SDK Workspace',
  slug: 'claude-sdk-workspace',
  rootPath: '',
  createdAt: Date.now(),
};

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'claude-sdk-e2e-config-'));
  process.env.CRAFT_CONFIG_DIR = configDir;
  wsRoot = mkdtempSync(join(tmpdir(), 'claude-sdk-e2e-ws-'));
  workspace.rootPath = wsRoot;
  registerHarnessDriver(new ClaudeSdkDriver());
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(wsRoot, { recursive: true, force: true });
  delete process.env.CRAFT_CONFIG_DIR;
});

function agentRef(managed: { agent: unknown } | null) {
  return (managed as unknown as { agent: { destroy(): void } | null } | null)?.agent ?? null;
}

describeE2E('Claude SDK real Gate B (env-gated)', () => {
  it(
    'real SDK round-trip + restart resume keeps the same native session',
    async () => {
      const word = `PONG-${Math.random().toString(36).slice(2, 8)}`;
      const agent = createAgent({
        id: 'claude-sdk-e2e',
        name: 'Claude SDK E2E Agent',
        // local-inherit (default): the SDK runs on the user's local Claude
        // config — no systemPrompt/model passed to the driver.
        execution: { kind: 'external-harness', harness: 'claude' },
        systemPrompt: 'You are the claude sdk e2e agent.',
      });
      const session = await ensureAgentSession(wsRoot, workspace.id, agent.id);
      expect(session.agentProfileSnapshot?.execution.kind).toBe('external-harness');

      // First incarnation: real SDK query (create → session_bound).
      const sm1 = new SessionManager();
      const managed1 = sm1.adoptPersistedSession(workspace, session.id);
      expect(managed1).not.toBeNull();
      try {
        await sm1.sendMessage(session.id, `Reply with exactly: ${word}`);
        await sessionPersistenceQueue.flush(session.id);
      } finally {
        agentRef(managed1)?.destroy();
      }

      const after1 = loadSession(wsRoot, session.id);
      expect(after1).not.toBeNull();
      const texts1 = after1!.messages.map((m) => m.content ?? '');
      expect(texts1.some((t) => t.includes(word))).toBe(true);
      // A real assistant reply exists (not just the echoed user message).
      const assistantReplies = after1!.messages
        .filter((m) => m.type === 'assistant')
        .map((m) => m.content ?? '');
      expect(assistantReplies.length).toBeGreaterThan(0);
      expect(assistantReplies.some((t) => t.includes('PONG'))).toBe(true);
      // session_bound worked: the real native id was persisted.
      expect(after1!.sdkSessionId).toBeTruthy();

      // Restart: fresh SessionManager + adopt → resume with the SAME native id.
      const sm2 = new SessionManager();
      const managed2 = sm2.adoptPersistedSession(workspace, session.id);
      expect(managed2).not.toBeNull();
      try {
        await sm2.sendMessage(session.id, `Second turn — reply with exactly: ${word}-2`);
        await sessionPersistenceQueue.flush(session.id);
      } finally {
        agentRef(managed2)?.destroy();
      }

      const after2 = loadSession(wsRoot, session.id);
      expect(after2).not.toBeNull();
      // Resume without fork: identical native session id.
      expect(after2!.sdkSessionId).toBe(after1!.sdkSessionId);
      // Both turns are on disk.
      const texts2 = after2!.messages.map((m) => m.content ?? '');
      expect(texts2.some((t) => t.includes(`${word}-2`))).toBe(true);
      expect(after2!.messages.length).toBeGreaterThan(after1!.messages.length);    },
    { timeout: 120_000 },
  );
});
