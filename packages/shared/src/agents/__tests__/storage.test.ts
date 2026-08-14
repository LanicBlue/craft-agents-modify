/**
 * Tests for the Agent Profile storage module.
 *
 * Isolation strategy: CONFIG_DIR is captured at module load time, so the
 * storage module is dynamically imported inside beforeAll AFTER
 * CRAFT_CONFIG_DIR points at a fresh temp directory. Each test then wipes the
 * agents subdirectory to start from an empty registry.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentExecutionConfig, AgentProfileRevision, AgentRecord } from '../types.ts';

type StorageModule = typeof import('../storage.ts');

let configDir: string;
let storage: StorageModule;

const backendExec: AgentExecutionConfig = {
  kind: 'craft-backend',
  llmConnection: 'anthropic',
  model: 'claude-opus-4-8',
};
const harnessExec: AgentExecutionConfig = { kind: 'external-harness', harness: 'codex', configMode: 'managed' };

function makeInput(overrides: Partial<Parameters<StorageModule['createAgent']>[0]> = {}) {
  return {
    name: 'Test Agent',
    description: 'A test agent',
    capabilities: ['browse'],
    execution: backendExec,
    thinkingLevel: 'high' as const,
    permissionMode: 'ask' as const,
    systemPrompt: 'You are a test agent.',
    enabledSourceSlugs: ['github'],
    ...overrides,
  };
}

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'agents-storage-test-'));
  process.env.CRAFT_CONFIG_DIR = configDir;
  // Dynamic import AFTER the env var is set — the module captures CONFIG_DIR at load.
  storage = await import('../storage.ts');
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.CRAFT_CONFIG_DIR;
});

beforeEach(() => {
  // Fresh, empty registry per test (module-level CONFIG_DIR is fixed).
  rmSync(join(configDir, 'agents'), { recursive: true, force: true });
});

const agentsDir = () => join(configDir, 'agents');

// ============================================================
// CRUD
// ============================================================

describe('createAgent', () => {
  it('writes registry.json + revision-1.json and returns the record', () => {
    const record = storage.createAgent(makeInput());

    expect(existsSync(join(agentsDir(), 'registry.json'))).toBe(true);
    expect(existsSync(join(agentsDir(), record.id, 'revisions', 'revision-1.json'))).toBe(true);
    expect(record.status).toBe('active');
    expect(record.latestRevision).toBe(1);
    expect(record.name).toBe('Test Agent');
    expect(record.createdAt).toBeGreaterThan(0);
    expect(record.updatedAt).toBeGreaterThan(0);
  });
});

describe('getAgent', () => {
  it('returns the record for an existing agent', () => {
    const created = storage.createAgent(makeInput());
    const found = storage.getAgent(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.name).toBe('Test Agent');
  });

  it('returns null for a missing agent', () => {
    expect(storage.getAgent('agent_nonexistent')).toBeNull();
  });
});

describe('listAgents', () => {
  it('excludes retired agents by default and includes them with includeRetired', () => {
    const a = storage.createAgent(makeInput({ name: 'A' }));
    const b = storage.createAgent(makeInput({ name: 'B' }));
    storage.retireAgent(a.id);

    expect(storage.listAgents().map((r) => r.id)).toEqual([b.id]);
    expect(storage.listAgents({ includeRetired: true }).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('updateAgent', () => {
  it('metadata-only update does not create a new revision', () => {
    const record = storage.createAgent(makeInput());
    const updated = storage.updateAgent(record.id, {
      name: 'Renamed',
      description: 'New description',
      capabilities: ['browse', 'edit'],
    });

    expect(updated.name).toBe('Renamed');
    expect(updated.description).toBe('New description');
    expect(updated.capabilities).toEqual(['browse', 'edit']);
    expect(updated.latestRevision).toBe(1);
    expect(existsSync(join(agentsDir(), record.id, 'revisions', 'revision-2.json'))).toBe(false);
  });

  it('config change creates a new revision and bumps latestRevision', () => {
    const record = storage.createAgent(makeInput());
    const updated = storage.updateAgent(record.id, { execution: harnessExec });

    expect(updated.latestRevision).toBe(2);
    expect(existsSync(join(agentsDir(), record.id, 'revisions', 'revision-2.json'))).toBe(true);
  });

  it('keeps the old revision byte-identical (immutability)', () => {
    const record = storage.createAgent(makeInput());
    const rev1Path = join(agentsDir(), record.id, 'revisions', 'revision-1.json');
    const before = readFileSync(rev1Path, 'utf-8');

    storage.updateAgent(record.id, { execution: harnessExec, thinkingLevel: 'max' });
    storage.updateAgent(record.id, { systemPrompt: 'Another prompt.' });

    expect(readFileSync(rev1Path, 'utf-8')).toBe(before);
  });

  it('new revision inherits unchanged fields from the previous revision', () => {
    const record = storage.createAgent(makeInput());
    const updated = storage.updateAgent(record.id, { execution: harnessExec });

    const rev2 = storage.loadRevision(record.id, 2);
    expect(rev2).not.toBeNull();
    expect(rev2!.execution.kind).toBe('external-harness');
    expect(rev2!.thinkingLevel).toBe('high');
    expect(rev2!.permissionMode).toBe('ask');
    expect(rev2!.enabledSourceSlugs).toEqual(['github']);
    expect(rev2!.systemPrompt).toBe('You are a test agent.');
    expect(updated.latestRevision).toBe(2);
  });

  it('throws for a missing agent', () => {
    expect(() => storage.updateAgent('agent_missing', { name: 'x' })).toThrow(/not found/);
  });
});

// ============================================================
// Revisions
// ============================================================

describe('revision loading', () => {
  it('loadRevision returns the full revision or null', () => {
    const record = storage.createAgent(makeInput());

    const rev = storage.loadRevision(record.id, 1);
    expect(rev).not.toBeNull();
    expect(rev!.agentId).toBe(record.id);
    expect(rev!.revision).toBe(1);
    expect(rev!.execution.kind).toBe('craft-backend');
    expect(rev!.systemPrompt).toBe('You are a test agent.');
    expect(storage.loadRevision(record.id, 99)).toBeNull();
    expect(storage.loadRevision('agent_00000000', 1)).toBeNull();
  });

  it('loadLatestRevision follows AgentRecord.latestRevision', () => {
    const record = storage.createAgent(makeInput());
    expect(storage.loadLatestRevision(record.id)?.revision).toBe(1);

    storage.updateAgent(record.id, { execution: harnessExec });
    expect(storage.loadLatestRevision(record.id)?.revision).toBe(2);
    expect(storage.loadLatestRevision('agent_missing')).toBeNull();
  });

  it('listRevisions returns revisions in ascending order', () => {
    const record = storage.createAgent(makeInput());
    storage.updateAgent(record.id, { execution: harnessExec });
    storage.updateAgent(record.id, { systemPrompt: 'Third prompt.' });

    const revisions = storage.listRevisions(record.id);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(storage.listRevisions('agent_00000000')).toEqual([]);
  });
});

// ============================================================
// Lifecycle
// ============================================================

describe('lifecycle', () => {
  it('retireAgent sets status to retired and preserves identity + history', () => {
    const record = storage.createAgent(makeInput());
    storage.updateAgent(record.id, { execution: harnessExec });

    const retired = storage.retireAgent(record.id);
    expect(retired.status).toBe('retired');
    expect(retired.id).toBe(record.id);
    expect(retired.latestRevision).toBe(2);
    expect(storage.listRevisions(record.id)).toHaveLength(2);
    expect(storage.getAgent(record.id)!.status).toBe('retired');
  });

  it('retireAgent is idempotent for an already-retired agent', () => {
    const record = storage.createAgent(makeInput());
    storage.retireAgent(record.id);
    expect(() => storage.retireAgent(record.id)).not.toThrow();
    expect(storage.getAgent(record.id)!.status).toBe('retired');
  });

  it('restoreAgent sets status back to active', () => {
    const record = storage.createAgent(makeInput());
    storage.retireAgent(record.id);
    const restored = storage.restoreAgent(record.id);
    expect(restored.status).toBe('active');
    expect(storage.listAgents().map((r) => r.id)).toEqual([record.id]);
  });

  it('restoreAgent is idempotent for an active agent', () => {
    const record = storage.createAgent(makeInput());
    expect(() => storage.restoreAgent(record.id)).not.toThrow();
    expect(storage.getAgent(record.id)!.status).toBe('active');
  });

  it('retireAgent/restoreAgent throw for a missing agent', () => {
    expect(() => storage.retireAgent('agent_missing')).toThrow(/not found/);
    expect(() => storage.restoreAgent('agent_missing')).toThrow(/not found/);
  });
});

// ============================================================
// Invariants
// ============================================================

describe('invariants', () => {
  it('agentId has the agent_{8-char-hex} format', () => {
    const record = storage.createAgent(makeInput());
    expect(record.id).toMatch(/^agent_[0-9a-f]{8}$/);
  });

  it('different createAgent calls produce different agentIds', () => {
    const a = storage.createAgent(makeInput({ name: 'A' }));
    const b = storage.createAgent(makeInput({ name: 'B' }));
    expect(a.id).not.toBe(b.id);
  });

  it('revisions never contain credentials or tokens', () => {
    const record = storage.createAgent(makeInput());
    storage.updateAgent(record.id, { execution: harnessExec });

    for (const rev of storage.listRevisions(record.id)) {
      const raw = JSON.parse(
        readFileSync(join(agentsDir(), record.id, 'revisions', `revision-${rev.revision}.json`), 'utf-8')
      );
      const json = JSON.stringify(raw).toLowerCase();
      expect(json).not.toContain('api_key');
      expect(json).not.toContain('apikey');
      expect(json).not.toContain('token');
      expect(json).not.toContain('secret');
      expect(json).not.toContain('credential');
    }
  });

  it('backs up a registry that fails to parse before treating it as empty', () => {
    mkdirSync(agentsDir(), { recursive: true });
    writeFileSync(join(agentsDir(), 'registry.json'), '{corrupt json', 'utf-8');

    const registry = storage.loadAgentRegistry();
    expect(registry.agents).toEqual([]);
    expect(existsSync(join(agentsDir(), 'registry.json'))).toBe(false);
    const backups = readdirSync(agentsDir()).filter((f) => f.startsWith('registry.json.corrupt-'));
    expect(backups).toHaveLength(1);
  });

  it('backs up a registry with an invalid shape before treating it as empty', () => {
    mkdirSync(agentsDir(), { recursive: true });
    writeFileSync(join(agentsDir(), 'registry.json'), JSON.stringify({ version: 1, agents: 'nope' }), 'utf-8');

    const registry = storage.loadAgentRegistry();
    expect(registry.agents).toEqual([]);
    const backups = readdirSync(agentsDir()).filter((f) => f.startsWith('registry.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(existsSync(join(agentsDir(), 'registry.json'))).toBe(false);
  });

  it('rejects malicious agentIds used in file paths', () => {
    expect(() => storage.loadRevision('../../etc/passwd', 1)).toThrow(/Invalid agent ID/);
    expect(() => storage.listRevisions('../../etc/passwd')).toThrow(/Invalid agent ID/);
    expect(() => storage.saveRevision({ agentId: '../../etc/passwd', revision: 1, execution: backendExec, systemPrompt: 'x', createdAt: 1 })).toThrow(/Invalid agent ID/);
  });

  it('well-formed but nonexistent agent ids do not throw', () => {
    expect(storage.loadRevision('agent_00000000', 1)).toBeNull();
    expect(storage.listRevisions('agent_00000000')).toEqual([]);
  });

  it('saveRevision accepts a well-formed manual revision', () => {
    const manual: AgentProfileRevision = { agentId: 'agent_00000005', revision: 5, execution: backendExec, systemPrompt: 'manual', createdAt: Date.now() };
    storage.saveRevision(manual);
    expect(storage.loadRevision('agent_00000005', 5)?.systemPrompt).toBe('manual');
  });
});
