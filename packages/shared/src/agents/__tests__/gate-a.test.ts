/**
 * Gate A (Issue #7) — P0 vertical slice integration tests.
 *
 * Proves the cross-module seams of the dispatch chain without a real
 * SessionManager or Claude backend:
 *
 *   (workspaceId, agentId) → ensureAgentSession → session materialization
 *   → reuse on redispatch → restart recovery → profile revision isolation
 *
 * Modules under test: agents/storage (registry + revisions) × agents/bindings
 * (canonical session binding) × sessions/storage (session persistence).
 * Mock dispatch = ensureAgentSession + session state verification
 * (sendMessage itself is out of scope here).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createAgent,
  updateAgent,
  retireAgent,
  restoreAgent,
} from '../storage.ts';
import {
  ensureAgentSession,
  getBinding,
  loadBinding,
  AgentSessionBindingError,
  type AgentSessionError,
} from '../bindings.ts';
import { deleteSession, loadSession } from '../../sessions/storage.ts';

let configDir: string;
let ws: string;

const exec = { kind: 'craft-backend' as const, llmConnection: 'anthropic', model: 'claude-opus-4-8' };

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
  configDir = mkdtempSync(join(tmpdir(), 'gate-a-config-'));
  process.env.CRAFT_CONFIG_DIR = configDir;
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.CRAFT_CONFIG_DIR;
});

beforeEach(() => {
  rmSync(join(configDir, 'agents'), { recursive: true, force: true });
  ws = mkdtempSync(join(tmpdir(), 'gate-a-ws-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function makeAgent() {
  return createAgent({
    id: 'gate-a-agent',
    name: 'Gate A Agent',
    execution: exec,
    systemPrompt: 'You are the gate agent.',
    thinkingLevel: 'max',
    permissionMode: 'ask',
    enabledSourceSlugs: ['github', 'linear'],
  });
}

describe('Gate A: full dispatch lifecycle', () => {
  it('materializes a session from the agent and reuses it on redispatch', async () => {
    const agent = makeAgent();

    const first = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(first.agentId).toBe(agent.id);
    expect(first.agentProfileRevision).toBe(1);
    expect(first.thinkingLevel).toBe('max');
    expect(first.permissionMode).toBe('ask');
    expect(first.model).toBe('claude-opus-4-8');
    // enabledSourceSlugs propagated from the snapshot
    expect(first.enabledSourceSlugs).toEqual(['github', 'linear']);
    expect(first.agentProfileSnapshot?.systemPrompt).toBe('You are the gate agent.');
    expect(getBinding(ws, agent.id)?.generation).toBe(1);

    const second = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(second.id).toBe(first.id);
    expect(getBinding(ws, agent.id)?.generation).toBe(1);
  });
});

describe('Gate A: restart recovery', () => {
  it('recovers binding + session from disk and reuses the same session', async () => {
    const agent = makeAgent();
    const dispatched = await ensureAgentSession(ws, 'ws-1', agent.id);

    // Simulate restart: re-read everything from disk (no in-memory state).
    const binding = loadBinding(ws, agent.id);
    expect(binding?.state).toBe('bound');
    expect(binding?.canonicalSessionId).toBe(dispatched.id);

    const recovered = loadSession(ws, dispatched.id);
    expect(recovered).not.toBeNull();
    expect(recovered!.agentId).toBe(agent.id);
    expect(recovered!.agentProfileRevision).toBe(1);
    expect(recovered!.agentProfileSnapshot).toEqual(dispatched.agentProfileSnapshot);
    expect(recovered!.agentBindingGeneration).toBe(binding?.generation);
    expect(recovered!.thinkingLevel).toBe('max');
    expect(recovered!.enabledSourceSlugs).toEqual(['github', 'linear']);

    // Redispatch after restart reuses the canonical session (no new creation).
    const redispatch = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(redispatch.id).toBe(dispatched.id);
    expect(getBinding(ws, agent.id)?.generation).toBe(1);
  });
});

describe('Gate A: profile revision isolation', () => {
  it('keeps rev1 snapshot on the live session after rev2; new session gets rev2', async () => {
    const agent = makeAgent();
    const session = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(session.agentProfileRevision).toBe(1);
    expect(session.agentProfileSnapshot?.systemPrompt).toBe('You are the gate agent.');

    // Update config → revision 2
    updateAgent(agent.id, { systemPrompt: 'You are the NEW gate agent.' });

    // Live session is NOT silently updated
    const stillLive = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(stillLive.id).toBe(session.id);
    expect(stillLive.agentProfileRevision).toBe(1);
    expect(stillLive.agentProfileSnapshot?.systemPrompt).toBe('You are the gate agent.');

    // Replace the canonical session → new session materializes rev2
    deleteSession(ws, session.id);
    expect(getBinding(ws, agent.id)?.state).toBe('unbound');

    const rebuilt = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(rebuilt.id).not.toBe(session.id);
    expect(rebuilt.agentProfileRevision).toBe(2);
    expect(rebuilt.agentProfileSnapshot?.systemPrompt).toBe('You are the NEW gate agent.');
  });
});

describe('Gate A: generation tracking', () => {
  it('increments generation across session replacements', async () => {
    const agent = makeAgent();

    const s1 = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(getBinding(ws, agent.id)?.generation).toBe(1);

    deleteSession(ws, s1.id);
    expect(getBinding(ws, agent.id)?.state).toBe('unbound');
    expect(getBinding(ws, agent.id)?.generation).toBe(1);

    const s2 = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(s2.id).not.toBe(s1.id);
    expect(getBinding(ws, agent.id)?.generation).toBe(2);
  });
});

describe('Gate A: retire/restore during binding lifecycle', () => {
  it('retire leaves the binding untouched; restore reuses the same session', async () => {
    const agent = makeAgent();
    const session = await ensureAgentSession(ws, 'ws-1', agent.id);

    retireAgent(agent.id);
    expect(getBinding(ws, agent.id)?.state).toBe('bound');
    expect(getBinding(ws, agent.id)?.generation).toBe(1);
    await expectError('AGENT_RETIRED', () => ensureAgentSession(ws, 'ws-1', agent.id));

    restoreAgent(agent.id);
    const redispatch = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(redispatch.id).toBe(session.id);
    expect(getBinding(ws, agent.id)?.generation).toBe(1);
  });
});

describe('Gate A: error propagation in dispatch flow', () => {
  it('throws AGENT_RETIRED for retired agents', async () => {
    const agent = makeAgent();
    retireAgent(agent.id);
    await expectError('AGENT_RETIRED', () => ensureAgentSession(ws, 'ws-1', agent.id));
  });

  it('throws AGENT_NOT_FOUND for unknown agents', async () => {
    await expectError('AGENT_NOT_FOUND', () => ensureAgentSession(ws, 'ws-1', 'no-such-agent'));
  });
});

describe('Gate A: failure paths (baseline acceptance)', () => {
  it('concurrent ensureAgentSession calls materialize exactly one session (gen 1)', async () => {
    const agent = makeAgent();

    // Parallel dispatch — e.g. PS fan-out against the same (workspace, agent).
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureAgentSession(ws, 'ws-1', agent.id))
    );

    const ids = new Set(results.map((s) => s.id));
    expect(ids.size).toBe(1);
    const binding = getBinding(ws, agent.id);
    expect(binding?.state).toBe('bound');
    expect(binding?.generation).toBe(1);
    expect(binding?.canonicalSessionId).toBe(results[0]!.id);
    // Exactly one session directory on disk.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(ws, '.craft-agent', 'sessions'))).toHaveLength(1);
  });

  it('corrupt snapshot (agentId set, snapshot missing) → AGENT_SESSION_UNAVAILABLE, never re-resolved from latest profile', async () => {
    const agent = makeAgent();
    const session = await ensureAgentSession(ws, 'ws-1', agent.id);

    // Tamper: strip the snapshot while keeping agentId + generation intact.
    const sessionPath = join(ws, '.craft-agent', 'sessions', session.id, 'session.jsonl');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const lines = readFileSync(sessionPath, 'utf-8').split('\n');
    const header = JSON.parse(lines[0]!);
    delete header.agentProfileSnapshot;
    lines[0] = JSON.stringify(header);
    writeFileSync(sessionPath, lines.join('\n'), 'utf-8');

    // The next revision exists — but the corrupt session must NOT be silently
    // re-resolved from it (#3 contract).
    updateAgent(agent.id, { systemPrompt: 'NEW prompt that must not be adopted.' });

    await expectError('AGENT_SESSION_UNAVAILABLE', () => ensureAgentSession(ws, 'ws-1', agent.id));
    // Binding untouched — still pointing at the corrupt session.
    const binding = getBinding(ws, agent.id);
    expect(binding?.state).toBe('bound');
    expect(binding?.canonicalSessionId).toBe(session.id);
    expect(binding?.generation).toBe(1);
  });

  it('legacy non-Agent sessions are never adopted and never acquire bindings', async () => {
    const agent = makeAgent();

    // Pre-existing legacy session: no agent fields at all.
    const { createSession, listSessions } = await import('../../sessions/storage.ts');
    const legacy = await createSession(ws, { name: 'legacy chat' });
    expect(legacy.agentId).toBeUndefined();

    const materialized = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(materialized.id).not.toBe(legacy.id);
    expect(materialized.agentId).toBe(agent.id);

    // Binding file exists only for the agent; legacy session has none.
    expect(getBinding(ws, legacy.id ?? 'none')).toBeNull();
    // Legacy session was not mutated.
    const legacyAfter = loadSession(ws, legacy.id)!;
    expect(legacyAfter.agentId).toBeUndefined();
    expect(legacyAfter.agentBindingGeneration).toBeUndefined();
    // Both sessions still listed — the legacy one untouched by the agent layer.
    expect(listSessions(ws).map((s) => s.id).sort()).toEqual([legacy.id, materialized.id].sort());
  });

  it('crash between session persist and binding publish: orphan is recovered, not duplicated', async () => {
    const agent = makeAgent();
    const session = await ensureAgentSession(ws, 'ws-1', agent.id);

    // Crash window: binding reverts to unbound gen 0, session (gen 1) persists.
    const { saveBinding } = await import('../bindings.ts');
    saveBinding(ws, {
      schemaVersion: 1,
      workspaceId: 'ws-1',
      agentId: agent.id,
      state: 'unbound',
      generation: 0,
      createdAt: 1,
      updatedAt: 1,
    });

    const recovered = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(recovered.id).toBe(session.id);
    expect(recovered.agentBindingGeneration).toBe(1);
    const binding = getBinding(ws, agent.id);
    expect(binding?.state).toBe('bound');
    expect(binding?.generation).toBe(1);
    expect(binding?.canonicalSessionId).toBe(session.id);
  });
});
