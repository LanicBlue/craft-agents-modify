/**
 * Tests for Agent × Workspace session bindings (Issue #4).
 *
 * Isolation: the agents registry honors CRAFT_CONFIG_DIR at call time (see
 * agents/storage.ts getAgentsDir), so setting the env var in beforeAll is
 * sufficient regardless of module load order. Each test also gets a fresh
 * temp workspace; beforeEach resets the agents registry.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
  loadBindings,
  saveBindings,
  getBindingsPath,
  AgentSessionBindingError,
  type AgentSessionError,
} from '../bindings.ts';
import { deleteSession } from '../../sessions/storage.ts';

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
  it('creates a session and an active binding (generation 1) on first call', async () => {
    const agent = createTestAgent();

    const session = await ensureAgentSession(ws, 'ws-1', agent.id);

    expect(existsSync(join(ws, '.craft-agent', 'sessions', session.id, 'session.jsonl'))).toBe(true);
    expect(session.agentId).toBe(agent.id);
    expect(session.agentProfileRevision).toBe(1);
    const binding = getBinding(ws, agent.id);
    expect(binding?.state).toBe('active');
    expect(binding?.generation).toBe(1);
    expect(binding?.canonicalSessionId).toBe(session.id);
    expect(binding?.workspaceId).toBe('ws-1');
  });

  it('reuses the same session on subsequent calls', async () => {
    const agent = createTestAgent();
    const first = await ensureAgentSession(ws, 'ws-1', agent.id);

    const second = await ensureAgentSession(ws, 'ws-1', agent.id);

    expect(second.id).toBe(first.id);
    expect(getBinding(ws, agent.id)?.generation).toBe(1);
  });

  it('replaces the session after deleteSession (generation+1)', async () => {
    const agent = createTestAgent();
    const first = await ensureAgentSession(ws, 'ws-1', agent.id);

    deleteSession(ws, first.id);
    expect(getBinding(ws, agent.id)?.state).toBe('unbound');
    expect(getBinding(ws, agent.id)?.generation).toBe(1);

    const second = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(second.id).not.toBe(first.id);
    expect(getBinding(ws, agent.id)?.state).toBe('active');
    expect(getBinding(ws, agent.id)?.generation).toBe(2);
  });

  it('auto-unbinds and recreates when the session was deleted externally', async () => {
    const agent = createTestAgent();
    const first = await ensureAgentSession(ws, 'ws-1', agent.id);

    // Delete the session directory directly (bypassing deleteSession hook)
    rmSync(join(ws, '.craft-agent', 'sessions', first.id), { recursive: true, force: true });

    const second = await ensureAgentSession(ws, 'ws-1', agent.id);
    expect(second.id).not.toBe(first.id);
    expect(getBinding(ws, agent.id)?.state).toBe('active');
    expect(getBinding(ws, agent.id)?.generation).toBe(2);
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
    const registry = loadBindings(ws);
    registry.bindings.push({
      workspaceId: 'ws-1',
      agentId: agent.id,
      canonicalSessionId: undefined,
      generation: 1,
      state: 'conflict',
      createdAt: 1,
      updatedAt: 1,
    });
    saveBindings(ws, registry);

    await expectError('AGENT_BINDING_CONFLICT', () => ensureAgentSession(ws, 'ws-1', agent.id));
    // Still conflict — untouched
    expect(getBinding(ws, agent.id)?.state).toBe('conflict');
  });
});

describe('retire/restore interplay', () => {
  it('retire/restore never touch bindings.json (byte-identical)', async () => {
    const agent = createTestAgent();
    await ensureAgentSession(ws, 'ws-1', agent.id);
    const before = readFileSync(getBindingsPath(ws), 'utf-8');

    retireAgent(agent.id);
    expect(readFileSync(getBindingsPath(ws), 'utf-8')).toBe(before);

    restoreAgent(agent.id);
    expect(readFileSync(getBindingsPath(ws), 'utf-8')).toBe(before);
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
    // stale active binding as-is (no auto-unbind).
    rmSync(join(ws, '.craft-agent', 'sessions', session.id), { recursive: true, force: true });
    const resolved = resolveBinding(ws, agent.id);
    expect(resolved?.state).toBe('active');
    expect(resolved?.canonicalSessionId).toBe(session.id);
  });

  it('unbindBySessionId is a no-op for non-bound sessions', async () => {
    const agent = createTestAgent();
    await ensureAgentSession(ws, 'ws-1', agent.id);

    unbindBySessionId(ws, 'unrelated-session');
    expect(getBinding(ws, agent.id)?.state).toBe('active');
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
  it('corrupt bindings.json returns an empty registry without throwing', () => {
    mkdirSync(join(ws, '.craft-agent', 'agent-sessions'), { recursive: true });
    writeFileSync(getBindingsPath(ws), '{corrupt json', 'utf-8');

    expect(() => loadBindings(ws)).not.toThrow();
    expect(loadBindings(ws).bindings).toEqual([]);
  });
});
