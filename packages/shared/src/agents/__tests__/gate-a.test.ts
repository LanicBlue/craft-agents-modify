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
  loadBindings,
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
    const binding = loadBindings(ws).bindings.find((b) => b.agentId === agent.id);
    expect(binding?.state).toBe('active');
    expect(binding?.canonicalSessionId).toBe(dispatched.id);

    const recovered = loadSession(ws, dispatched.id);
    expect(recovered).not.toBeNull();
    expect(recovered!.agentId).toBe(agent.id);
    expect(recovered!.agentProfileRevision).toBe(1);
    expect(recovered!.agentProfileSnapshot).toEqual(dispatched.agentProfileSnapshot);
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
    expect(getBinding(ws, agent.id)?.state).toBe('active');
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
    await expectError('AGENT_NOT_FOUND', () => ensureAgentSession(ws, 'ws-1', 'agent_deadbeef'));
  });
});
