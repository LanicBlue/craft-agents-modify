/**
 * Tests for Agent × Workspace session bindings (Issue #4, baseline rework).
 *
 * Implementation baseline contract (supersedes earlier 'active' semantics):
 * - per-agent binding files (agent-sessions/{agentId}.json)
 * - bound / unbound / conflict states; 'bound' is validated on reuse against
 *   the session's agentBindingGeneration
 * - bound + canonical session missing/mismatched → AGENT_SESSION_UNAVAILABLE
 *   (binding untouched — recovery is manual or via deleteSession's hook)
 *
 * Isolation: the agents registry honors CRAFT_CONFIG_DIR at call time (see
 * agents/storage.ts getAgentsDir), so setting the env var in beforeAll is
 * sufficient regardless of module load order. Each test also gets a fresh
 * temp workspace; beforeEach resets the agents registry.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createAgent,
  retireAgent,
  restoreAgent,
} from '../storage.ts';
import {
  ensureAgentSession,
  unbindBySessionId,
  resolveBinding,
  getBinding,
  loadBinding,
  saveBinding,
  getBindingPath,
  AgentSessionBindingError,
  type AgentSessionError,
} from '../bindings.ts';
import { deleteSession, loadSession } from '../../sessions/storage.ts';

let configDir: string;
let ws: string;

const exec = { kind: 'craft-backend' as const, llmConnection: 'anthropic', model: 'claude-opus-4-8' };

function createTestAgent(name = 'Binding Agent') {
  return createAgent({ name, execution: exec, systemPrompt: 'You are bound.' });
}

async function expectError(code: AgentSessionError, fn: () => Promise<unknown>) {
  try {
    await fn();
    throw new Error(`expected ${code} but no error was thrown`);
  } catch (err) {
    if (err instanceof AgentSessionBindingError) {
      expect(err.code).toBe(code);
    } else {
      throw err;
    }
  }
}

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'bindings-test-config-'));
  process.env.CRAFT_CONFIG_DIR = configDir;
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.CRAFT_CONFIG_DIR;
});

beforeEach(() => {
  rmSync(join(configDir, 'agents'), { recursive: true, force: true });
  ws = mkdtempSync(join(tmpdir(), 'bindings-test-ws-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('ensureAgentSession', () => {
  it('creates a session and a bound binding (generation 1) on first call', async () => {
    const agent = createTestAgent();

    const session = await ensureAgentSession(ws, 'ws-1', agent.id);

    expect(existsSync(join(ws, '.craft-agent', 'sessions', session.id, 'session.jsonl'))).toBe(true);
    expect(session.agentId).toBe(agent.id);
    expect(session.agentProfileRevision).toBe(1);
    expect(session.agentBindingGeneration).toBe(1);
    const binding = getBinding(ws, agent.id);
    expect(binding?.state).toBe('bound');
    expect(binding?.generation).toBe(1);
    expect(binding?.canonicalSessionId).toBe(session.id);
    expect(binding?.workspaceId).toBe('ws-1');
    // Session generation and binding generation agree.
    expect(binding?.generation).toBe(session.agentBindingGeneration);
  });

  it('reuses the same session on subsequent calls without bumping generation', async () => {
    const agent = createTestAgent();
    const first = await ensureAgentSession(ws, 'ws-1', agent.id);

    const second = await ensureAgentSession(ws, 'ws-1', agent.id);

    expect(second.id).toBe(first.id);
    expect(getBinding(ws, agent.id)?.generation).toBe(1);
    expect(second.agentBindingGeneration).toBe(1);
  });

  it('replaces the session after deleteSession (generation+1)', async () => {
    const agent = createTestAgent();
    const first = await ensureAgentSession(ws, 'ws-1', agent.id);

    deleteSession(ws, first.id);
    expect(getBinding(ws, agent.id)?.state).toBe('unbound');
    expect(getBinding(ws, agent.id)?.generation).toBe(1);

    const second = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(second.id).not.toBe(first.id);
    expect(getBinding(ws, agent.id)?.state).toBe('bound');
    expect(getBinding(ws, agent.id)?.generation).toBe(2);
    expect(second.agentBindingGeneration).toBe(2);
  });

  it('throws AGENT_SESSION_UNAVAILABLE when the bound session was deleted externally', async () => {
    const agent = createTestAgent();
    const first = await ensureAgentSession(ws, 'ws-1', agent.id);

    // Delete the session directory directly (bypassing the deleteSession hook).
    rmSync(join(ws, '.craft-agent', 'sessions', first.id), { recursive: true, force: true });

    await expectError('AGENT_SESSION_UNAVAILABLE', () => ensureAgentSession(ws, 'ws-1', agent.id));
    // Binding stays 'bound' and untouched — no silent rebuild.
    const binding = getBinding(ws, agent.id);
    expect(binding?.state).toBe('bound');
    expect(binding?.canonicalSessionId).toBe(first.id);
    expect(binding?.generation).toBe(1);
  });

  it('throws AGENT_SESSION_UNAVAILABLE when the bound session mismatches the binding generation', async () => {
    const agent = createTestAgent();
    const first = await ensureAgentSession(ws, 'ws-1', agent.id);

    // Tamper: overwrite the session's generation so it no longer matches the binding.
    const sessionPath = join(ws, '.craft-agent', 'sessions', first.id, 'session.jsonl');
    const headerLine = readFileSync(sessionPath, 'utf-8').split('\n')[0]!;
    const stored = JSON.parse(headerLine);
    stored.agentBindingGeneration = 99;
    const headerWithMessages = [JSON.stringify(stored), ...readFileSync(sessionPath, 'utf-8').split('\n').slice(1)].join('\n');
    writeFileSync(sessionPath, headerWithMessages, 'utf-8');

    await expectError('AGENT_SESSION_UNAVAILABLE', () => ensureAgentSession(ws, 'ws-1', agent.id));
    expect(getBinding(ws, agent.id)?.state).toBe('bound');
  });

  it('throws AGENT_RETIRED for retired agents', async () => {
    const agent = createTestAgent();
    retireAgent(agent.id);

    await expectError('AGENT_RETIRED', () => ensureAgentSession(ws, 'ws-1', agent.id));
  });

  it('throws AGENT_NOT_FOUND for unknown agents', async () => {
    await expectError('AGENT_NOT_FOUND', () => ensureAgentSession(ws, 'ws-1', 'agent_deadbeef'));
  });

  it('throws AGENT_BINDING_CONFLICT for conflict bindings without auto-resolving', async () => {
    const agent = createTestAgent();
    saveBinding(ws, {
      schemaVersion: 1,
      workspaceId: 'ws-1',
      agentId: agent.id,
      canonicalSessionId: undefined,
      generation: 1,
      state: 'conflict',
      createdAt: 1,
      updatedAt: 1,
    });

    await expectError('AGENT_BINDING_CONFLICT', () => ensureAgentSession(ws, 'ws-1', agent.id));
    // Still conflict — untouched
    expect(getBinding(ws, agent.id)?.state).toBe('conflict');
  });
});

describe('retire/restore interplay', () => {
  it('retire/restore never touch the binding file (byte-identical)', async () => {
    const agent = createTestAgent();
    await ensureAgentSession(ws, 'ws-1', agent.id);
    const before = readFileSync(getBindingPath(ws, agent.id), 'utf-8');

    retireAgent(agent.id);
    expect(readFileSync(getBindingPath(ws, agent.id), 'utf-8')).toBe(before);

    restoreAgent(agent.id);
    expect(readFileSync(getBindingPath(ws, agent.id), 'utf-8')).toBe(before);
  });

  it('after restore, ensure reuses the still-existing session', async () => {
    const agent = createTestAgent();
    const first = await ensureAgentSession(ws, 'ws-1', agent.id);

    retireAgent(agent.id);
    await expectError('AGENT_RETIRED', () => ensureAgentSession(ws, 'ws-1', agent.id));

    restoreAgent(agent.id);
    const second = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(second.id).toBe(first.id);
    expect(getBinding(ws, agent.id)?.generation).toBe(1);
  });
});

describe('resolveBinding / unbindBySessionId', () => {
  it('resolveBinding never transitions state', async () => {
    const agent = createTestAgent();
    const session = await ensureAgentSession(ws, 'ws-1', agent.id);

    // Delete the session externally — resolveBinding must still return the
    // stale bound binding as-is (no auto-unbind).
    rmSync(join(ws, '.craft-agent', 'sessions', session.id), { recursive: true, force: true });
    const resolved = resolveBinding(ws, agent.id);
    expect(resolved?.state).toBe('bound');
    expect(resolved?.canonicalSessionId).toBe(session.id);
  });

  it('unbindBySessionId is a no-op for non-bound sessions', async () => {
    const agent = createTestAgent();
    await ensureAgentSession(ws, 'ws-1', agent.id);

    unbindBySessionId(ws, 'unrelated-session');
    expect(getBinding(ws, agent.id)?.state).toBe('bound');
  });

  it('unbindBySessionId unbinds the matching session and preserves generation', async () => {
    const agent = createTestAgent();
    const session = await ensureAgentSession(ws, 'ws-1', agent.id);

    unbindBySessionId(ws, session.id);
    const binding = getBinding(ws, agent.id);
    expect(binding?.state).toBe('unbound');
    expect(binding?.canonicalSessionId).toBeUndefined();
    expect(binding?.generation).toBe(1);
  });
});

describe('bindings storage resilience', () => {
  it('corrupt binding file returns null without throwing', () => {
    const agent = createTestAgent();
    mkdirSync(join(ws, '.craft-agent', 'agent-sessions'), { recursive: true });
    writeFileSync(getBindingPath(ws, agent.id), '{corrupt json', 'utf-8');

    expect(() => loadBinding(ws, agent.id)).not.toThrow();
    expect(loadBinding(ws, agent.id)).toBeNull();
  });
});

describe('corrupt binding → explicit conflict (Wave 1 R3)', () => {
  it('never materializes a replacement session; backs up the corrupt file; conflict records candidates', async () => {
    const agent = createTestAgent();
    const first = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(getBinding(ws, agent.id)?.state).toBe('bound');

    // Owner repro: corrupt the binding file after a live gen-1 session exists.
    const corruptContent = '{corrupt json!!';
    writeFileSync(getBindingPath(ws, agent.id), corruptContent, 'utf-8');

    const sessionsBefore = readdirSync(join(ws, '.craft-agent', 'sessions')).length;
    await expectError('AGENT_BINDING_CONFLICT', () => ensureAgentSession(ws, 'ws-1', agent.id));

    // No new session was materialized (the old gen-1 session stays canonical).
    const sessionsAfter = readdirSync(join(ws, '.craft-agent', 'sessions')).length;
    expect(sessionsAfter).toBe(sessionsBefore);
    expect(loadSession(ws, first.id)).not.toBeNull();

    // The corrupt bytes are preserved verbatim in the backup file.
    const backups = readdirSync(join(ws, '.craft-agent', 'agent-sessions')).filter((f) =>
      f.startsWith(`${agent.id}.json.corrupt-`)
    );
    expect(backups.length).toBe(1);
    expect(readFileSync(join(ws, '.craft-agent', 'agent-sessions', backups[0]!), 'utf-8')).toBe(
      corruptContent
    );

    // The binding is now an explicit conflict with the live session as candidate.
    const binding = getBinding(ws, agent.id);
    expect(binding?.state).toBe('conflict');
    expect(binding?.conflict?.reason).toBe('corrupt binding file');
    expect(binding?.conflict?.candidateSessionIds).toContain(first.id);
    expect(typeof binding?.conflict?.detectedAt).toBe('number');

    // Subsequent calls keep failing with the conflict — no retry loop.
    await expectError('AGENT_BINDING_CONFLICT', () => ensureAgentSession(ws, 'ws-1', agent.id));
  });
});

describe('crash recovery (orphan session candidates, baseline step 5)', () => {
  /**
   * Simulate a crash between session persistence (step 6) and binding publish
   * (step 7) by rewriting the published binding back to 'unbound' while the
   * on-disk session keeps claiming generation N+1.
   */
  function revertBindingToUnbound(agentId: string, generation: number) {
    const binding = loadBinding(ws, agentId)!;
    saveBinding(ws, {
      ...binding,
      state: 'unbound',
      canonicalSessionId: undefined,
      generation,
      updatedAt: Date.now(),
    });
  }

  it('adopts the unique orphan claiming generation N+1 instead of creating a duplicate', async () => {
    const agent = createTestAgent();
    const first = await ensureAgentSession(ws, 'ws-1', agent.id);

    // Crash window: session (gen 1) persisted, binding reverted to unbound gen 0.
    revertBindingToUnbound(agent.id, 0);

    const recovered = await ensureAgentSession(ws, 'ws-1', agent.id);

    // The orphan was recovered — same session, no duplicate materialization.
    expect(recovered.id).toBe(first.id);
    expect(recovered.agentBindingGeneration).toBe(1);
    const binding = getBinding(ws, agent.id);
    expect(binding?.state).toBe('bound');
    expect(binding?.canonicalSessionId).toBe(first.id);
    expect(binding?.generation).toBe(1);
    // Exactly one session for this agent on disk.
    const sessionDir = join(ws, '.craft-agent', 'sessions');
    expect(readdirSync(sessionDir).filter((id) => id !== '.DS_Store')).toHaveLength(1);
  });

  it('multiple orphans claiming the same generation → AGENT_BINDING_CONFLICT, never auto-resolved', async () => {
    const agent = createTestAgent();
    await ensureAgentSession(ws, 'ws-1', agent.id);

    // Manufacture a second orphan claiming generation 1 (crash-window duplicate).
    const { createSession } = await import('../../sessions/storage.ts');
    const { loadLatestRevision, resolveAgentSnapshot } = await import('../storage.ts');
    const revision = loadLatestRevision(agent.id)!;
    const duplicate = await createSession(ws, {
      agentId: agent.id,
      agentProfileRevision: revision.revision,
      agentProfileSnapshot: resolveAgentSnapshot(revision),
      agentBindingGeneration: 1,
    });
    expect(duplicate.agentBindingGeneration).toBe(1);

    // Both sessions now claim generation 1 against an unbound gen-0 binding.
    revertBindingToUnbound(agent.id, 0);

    await expectError('AGENT_BINDING_CONFLICT', () => ensureAgentSession(ws, 'ws-1', agent.id));
    // Binding stays unbound — untouched, no silent winner.
    expect(getBinding(ws, agent.id)?.state).toBe('unbound');
  });
});
