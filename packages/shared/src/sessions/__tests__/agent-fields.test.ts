/**
 * Tests for agent identity / profile snapshot persistence in sessions
 * (Issue #3 Step 1 fields: agentId, agentProfileRevision, agentProfileSnapshot).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createSession,
  loadSession,
  updateSessionMetadata,
  listSessions,
} from '../storage.ts';
import type { AgentProfileSnapshot } from '../../agents/types.ts';

let ws: string;
const sessionsDir = () => join(ws, '.craft-agent', 'sessions');

const snapshot: AgentProfileSnapshot = {
  execution: { kind: 'craft-backend', llmConnection: 'anthropic', model: 'claude-opus-4-8' },
  model: 'claude-opus-4-8',
  thinkingLevel: 'max',
  permissionMode: 'ask',
  systemPrompt: 'You are a test agent.',
  enabledSourceSlugs: ['github'],
};

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'sessions-agent-fields-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function writeLegacySession(id: string): string {
  // Hand-written session.jsonl WITHOUT any agent fields (pre-Issue #3 format).
  const dir = join(sessionsDir(), id);
  mkdirSync(dir, { recursive: true });
  const header = {
    id,
    workspaceRootPath: ws,
    createdAt: 1,
    lastUsedAt: 1,
    messageCount: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  };
  writeFileSync(join(dir, 'session.jsonl'), `${JSON.stringify(header)}\n`, 'utf-8');
  return id;
}

describe('createSession with agent fields', () => {
  it('returns the agent fields and persists them in the JSONL header', async () => {
    const session = await createSession(ws, {
      name: 'agent session',
      agentId: 'agent_12345678',
      agentProfileRevision: 3,
      agentProfileSnapshot: snapshot,
    });

    expect(session.agentId).toBe('agent_12345678');
    expect(session.agentProfileRevision).toBe(3);
    expect(session.agentProfileSnapshot).toEqual(snapshot);

    const headerLine = readFileSync(
      join(sessionsDir(), session.id, 'session.jsonl'),
      'utf-8'
    ).split('\n')[0]!;
    expect(headerLine).toContain('"agentId":"agent_12345678"');
    expect(headerLine).toContain('"agentProfileRevision":3');
    expect(headerLine).toContain('"agentProfileSnapshot"');
    expect(headerLine).toContain('"systemPrompt"');
  });

  it('loadSession fully restores agentId / agentProfileRevision / agentProfileSnapshot', async () => {
    const session = await createSession(ws, {
      agentId: 'agent_12345678',
      agentProfileRevision: 3,
      agentProfileSnapshot: snapshot,
    });

    const loaded = loadSession(ws, session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.agentId).toBe('agent_12345678');
    expect(loaded!.agentProfileRevision).toBe(3);
    expect(loaded!.agentProfileSnapshot).toEqual(snapshot);
  });
});

describe('legacy sessions without agent fields', () => {
  it('loadSession returns undefined agent fields without throwing', () => {
    const id = writeLegacySession('250101-old-legacy');

    const loaded = loadSession(ws, id);
    expect(loaded).not.toBeNull();
    expect(loaded!.agentId).toBeUndefined();
    expect(loaded!.agentProfileRevision).toBeUndefined();
    expect(loaded!.agentProfileSnapshot).toBeUndefined();
  });

  it('a session created without agent options has undefined agent fields', async () => {
    const session = await createSession(ws, { name: 'plain' });
    expect(session.agentId).toBeUndefined();
    expect(session.agentProfileRevision).toBeUndefined();
    expect(session.agentProfileSnapshot).toBeUndefined();
  });
});

describe('listSessions metadata', () => {
  it('exposes agentId but never agentProfileSnapshot/agentProfileRevision', async () => {
    const session = await createSession(ws, {
      agentId: 'agent_12345678',
      agentProfileRevision: 3,
      agentProfileSnapshot: snapshot,
    });
    writeLegacySession('250101-old-legacy');

    const metas = listSessions(ws);
    const meta = metas.find((m) => m.id === session.id);
    expect(meta).toBeDefined();
    expect(meta!.agentId).toBe('agent_12345678');
    expect('agentProfileSnapshot' in meta!).toBe(false);
    expect('agentProfileRevision' in meta!).toBe(false);
    // Legacy session metadata also exposes no agent fields
    const legacyMeta = metas.find((m) => m.id === '250101-old-legacy');
    expect(legacyMeta!.agentId).toBeUndefined();
    expect('agentProfileSnapshot' in legacyMeta!).toBe(false);
  });
});

describe('updateSessionMetadata agentId', () => {
  it('updates the agentId on an existing session', async () => {
    const session = await createSession(ws, { agentId: 'agent_12345678' });
    await updateSessionMetadata(ws, session.id, { agentId: 'agent_abcdef01' });

    const loaded = loadSession(ws, session.id);
    expect(loaded!.agentId).toBe('agent_abcdef01');
    // Other fields untouched
    expect(loaded!.agentProfileRevision).toBeUndefined();
  });

  it('does not create or modify anything for a missing session', async () => {
    await updateSessionMetadata(ws, 'nonexistent-session', { agentId: 'agent_12345678' });
    expect(existsSync(sessionsDir())).toBe(false);
  });
});
