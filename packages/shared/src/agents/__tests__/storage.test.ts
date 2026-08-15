/**
 * Tests for the Agent Profile storage module (Issue #2 layout).
 *
 * Layout: {CONFIG_DIR}/agents/{agentId}/agent.json + revisions/000001.json
 * (6-digit zero-padded). No registry.json — the directory IS the registry.
 *
 * Isolation strategy: CONFIG_DIR is captured at module load time, so the
 * storage module is dynamically imported inside beforeAll AFTER
 * CRAFT_CONFIG_DIR points at a fresh temp directory. Each test then wipes the
 * agents subdirectory to start from an empty registry.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
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
    id: 'test-agent',
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
  // Fresh, empty agents dir per test (module-level CONFIG_DIR is fixed).
  rmSync(join(configDir, 'agents'), { recursive: true, force: true });
});

const agentsDir = () => join(configDir, 'agents');
const agentDir = (id: string) => join(agentsDir(), id);
const revPath = (id: string, rev: number) =>
  join(agentDir(id), 'revisions', `${String(rev).padStart(6, '0')}.json`);

function expectRegistryError(fn: () => unknown, code: string) {
  try {
    fn();
    expect.unreachable(`expected ${code} to be thrown`);
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
  }
}

// ============================================================
// CRUD
// ============================================================

describe('createAgent', () => {
  it('writes agent.json + 000001.json and returns the record', () => {
    const record = storage.createAgent(makeInput());

    expect(existsSync(join(agentDir(record.id), 'agent.json'))).toBe(true);
    expect(existsSync(revPath(record.id, 1))).toBe(true);
    // No registry.json under the new layout.
    expect(existsSync(join(agentsDir(), 'registry.json'))).toBe(false);
    expect(record.schemaVersion).toBe(1);
    expect(record.status).toBe('active');
    expect(record.recordVersion).toBe(1);
    expect(record.latestProfileRevision).toBe(1);
    expect(record.name).toBe('Test Agent');
    expect(record.createdAt).toBeGreaterThan(0);
    expect(record.updatedAt).toBeGreaterThan(0);
  });

  it('rejects an invalid id with AGENT_ID_INVALID', () => {
    for (const bad of ['', 'Agent-X', 'agent_X', '9agent', 'a'.repeat(65), 'agent/x', '../escape']) {
      expectRegistryError(() => storage.createAgent(makeInput({ id: bad })), 'AGENT_ID_INVALID');
    }
  });

  it('rejects a duplicate id with AGENT_ALREADY_EXISTS', () => {
    storage.createAgent(makeInput({ id: 'dup-agent' }));
    expectRegistryError(() => storage.createAgent(makeInput({ id: 'dup-agent' })), 'AGENT_ALREADY_EXISTS');
  });

  it('creates distinct records for distinct ids', () => {
    const a = storage.createAgent(makeInput({ id: 'agent-a' }));
    const b = storage.createAgent(makeInput({ id: 'agent-b' }));
    expect(a.id).toBe('agent-a');
    expect(b.id).toBe('agent-b');
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
    expect(storage.getAgent('no-such-agent')).toBeNull();
  });

  it('rejects a malicious id with AGENT_ID_INVALID', () => {
    expectRegistryError(() => storage.getAgent('../../etc/passwd'), 'AGENT_ID_INVALID');
  });

  it('raises AGENT_STORAGE_CORRUPT for an unreadable agent.json', () => {
    const record = storage.createAgent(makeInput());
    writeFileSync(join(agentDir(record.id), 'agent.json'), '{corrupt', 'utf-8');
    expectRegistryError(() => storage.getAgent(record.id), 'AGENT_STORAGE_CORRUPT');
  });

  it('rejects an agent.json whose embedded id does not match its directory', () => {
    const record = storage.createAgent(makeInput());
    const path = join(agentDir(record.id), 'agent.json');
    const persisted = JSON.parse(readFileSync(path, 'utf-8'));
    persisted.id = 'other-agent';
    writeFileSync(path, JSON.stringify(persisted), 'utf-8');

    expectRegistryError(() => storage.getAgent(record.id), 'AGENT_STORAGE_CORRUPT');
  });
});

describe('listAgents', () => {
  it('aggregates from the directory; excludes retired by default', () => {
    const a = storage.createAgent(makeInput({ id: 'list-a' }));
    const b = storage.createAgent(makeInput({ id: 'list-b' }));
    storage.retireAgent(a.id);

    expect(storage.listAgents().map((r) => r.id)).toEqual([b.id]);
    expect(storage.listAgents({ includeRetired: true }).map((r) => r.id).sort()).toEqual(['list-a', 'list-b']);
  });

  it('skips corrupt agent.json entries with a debug log (no throw)', () => {
    storage.createAgent(makeInput({ id: 'good-agent' }));
    mkdirSync(join(agentsDir(), 'broken-agent'), { recursive: true });
    writeFileSync(join(agentsDir(), 'broken-agent', 'agent.json'), '{corrupt', 'utf-8');

    const agents = storage.listAgents();
    expect(agents.map((r) => r.id)).toEqual(['good-agent']);
  });

  it('returns [] for an empty agents directory', () => {
    expect(storage.listAgents()).toEqual([]);
  });
});

// ============================================================
// updateAgent — CAS + revision commit sequence
// ============================================================

describe('updateAgent', () => {
  it('metadata-only update does not create a new revision but bumps recordVersion', () => {
    const record = storage.createAgent(makeInput());
    const updated = storage.updateAgent(record.id, {
      name: 'Renamed',
      description: 'New description',
      capabilities: ['browse', 'edit'],
    });

    expect(updated.name).toBe('Renamed');
    expect(updated.description).toBe('New description');
    expect(updated.capabilities).toEqual(['browse', 'edit']);
    expect(updated.latestProfileRevision).toBe(1);
    expect(updated.recordVersion).toBe(record.recordVersion + 1);
    expect(existsSync(revPath(record.id, 2))).toBe(false);
  });

  it('config change commits revision N+1 and bumps recordVersion + pointer', () => {
    const record = storage.createAgent(makeInput());
    const updated = storage.updateAgent(record.id, { execution: harnessExec });

    expect(updated.latestProfileRevision).toBe(2);
    expect(updated.recordVersion).toBe(2);
    expect(existsSync(revPath(record.id, 2))).toBe(true);
    // Revision file is 6-digit zero-padded.
    expect(readdirSync(join(agentDir(record.id), 'revisions'))).toContain('000002.json');
  });

  it('keeps the old revision byte-identical (immutability)', () => {
    const record = storage.createAgent(makeInput());
    const rev1Path = revPath(record.id, 1);
    const before = readFileSync(rev1Path, 'utf-8');

    storage.updateAgent(record.id, { execution: harnessExec, thinkingLevel: 'max' });
    storage.updateAgent(record.id, { systemPrompt: 'Another prompt.' });

    expect(readFileSync(rev1Path, 'utf-8')).toBe(before);
  });

  it('new revision inherits unchanged fields from the previous revision', () => {
    const record = storage.createAgent(makeInput());
    const updated = storage.updateAgent(record.id, { execution: harnessExec });

    const rev2 = storage.loadRevision(record.id, 2);
    expect(rev2.execution.kind).toBe('external-harness');
    expect(rev2.thinkingLevel).toBe('high');
    expect(rev2.permissionMode).toBe('ask');
    expect(rev2.enabledSourceSlugs).toEqual(['github']);
    expect(rev2.systemPrompt).toBe('You are a test agent.');
    expect(updated.latestProfileRevision).toBe(2);
  });

  it('CAS: stale expectedRecordVersion → AGENT_VERSION_CONFLICT', () => {
    const record = storage.createAgent(makeInput());
    storage.updateAgent(record.id, { name: 'v2' }); // recordVersion → 2
    expect(record.recordVersion).toBe(1);

    // Fresh read knows the current version; stale caller gets a conflict.
    expectRegistryError(
      () => storage.updateAgent(record.id, { name: 'stale' }, record.recordVersion),
      'AGENT_VERSION_CONFLICT'
    );
    // Correct expected version succeeds.
    const ok = storage.updateAgent(record.id, { name: 'fresh' }, 2);
    expect(ok.name).toBe('fresh');
    expect(ok.recordVersion).toBe(3);
  });

  it('throws AGENT_NOT_FOUND for a missing agent', () => {
    expectRegistryError(() => storage.updateAgent('missing-agent', { name: 'x' }), 'AGENT_NOT_FOUND');
  });

  it('raises AGENT_STORAGE_CORRUPT when the pointer target is missing', () => {
    const record = storage.createAgent(makeInput());
    storage.updateAgent(record.id, { execution: harnessExec });
    // Break the pointer: delete revision 2 (the pointer target).
    rmSync(revPath(record.id, 2), { force: true });

    expectRegistryError(() => storage.updateAgent(record.id, { systemPrompt: 'x' }), 'AGENT_STORAGE_CORRUPT');
  });
});

// ============================================================
// Revisions
// ============================================================

describe('revision loading', () => {
  it('loadRevision returns the full revision; missing → AGENT_PROFILE_REVISION_NOT_FOUND', () => {
    const record = storage.createAgent(makeInput());

    const rev = storage.loadRevision(record.id, 1);
    expect(rev.agentId).toBe(record.id);
    expect(rev.revision).toBe(1);
    expect(rev.execution.kind).toBe('craft-backend');
    expect(rev.systemPrompt).toBe('You are a test agent.');
    expectRegistryError(() => storage.loadRevision(record.id, 99), 'AGENT_PROFILE_REVISION_NOT_FOUND');
    expectRegistryError(() => storage.loadRevision('unknown-agent', 1), 'AGENT_PROFILE_REVISION_NOT_FOUND');
  });

  it('loadLatestRevision follows the pointer; broken pointer → AGENT_STORAGE_CORRUPT', () => {
    const record = storage.createAgent(makeInput());
    expect(storage.loadLatestRevision(record.id)?.revision).toBe(1);

    storage.updateAgent(record.id, { execution: harnessExec });
    expect(storage.loadLatestRevision(record.id)?.revision).toBe(2);

    // Missing agent → null (compat).
    expect(storage.loadLatestRevision('missing-agent')).toBeNull();

    // Corrupt pointer target → explicit corruption, never silent fallback.
    rmSync(revPath(record.id, 2), { force: true });
    expectRegistryError(() => storage.loadLatestRevision(record.id), 'AGENT_STORAGE_CORRUPT');
  });

  it('corrupt revision file → AGENT_STORAGE_CORRUPT via pointer, AGENT_PROFILE_INVALID via direct load', () => {
    const record = storage.createAgent(makeInput());
    writeFileSync(revPath(record.id, 1), '{corrupt', 'utf-8');
    expectRegistryError(() => storage.loadLatestRevision(record.id), 'AGENT_STORAGE_CORRUPT');
    expectRegistryError(() => storage.loadRevision(record.id, 1), 'AGENT_PROFILE_INVALID');
  });

  it('non-object revision contents (null/string/array) are rejected as invalid', () => {
    const record = storage.createAgent(makeInput());
    const valid = JSON.stringify({
      agentId: record.id,
      revision: 1,
      execution: backendExec,
      systemPrompt: 'You are a test agent.',
      createdAt: 1,
    });
    for (const bad of ['null', JSON.stringify('a string'), JSON.stringify([1, 2, 3])]) {
      writeFileSync(revPath(record.id, 1), bad, 'utf-8');
      expectRegistryError(() => storage.loadRevision(record.id, 1), 'AGENT_PROFILE_INVALID');
      expectRegistryError(() => storage.loadLatestRevision(record.id), 'AGENT_STORAGE_CORRUPT');
      // Restore a valid revision for the next iteration.
      writeFileSync(revPath(record.id, 1), valid, 'utf-8');
    }
  });

  it('rejects a revision whose embedded agentId or revision does not match its path', () => {
    const record = storage.createAgent(makeInput());
    const path = revPath(record.id, 1);
    const valid = JSON.parse(readFileSync(path, 'utf-8')) as AgentProfileRevision;

    for (const bad of [
      { ...valid, agentId: 'other-agent' },
      { ...valid, revision: 99 },
    ]) {
      writeFileSync(path, JSON.stringify(bad), 'utf-8');
      expectRegistryError(() => storage.loadRevision(record.id, 1), 'AGENT_PROFILE_INVALID');
      expectRegistryError(() => storage.loadLatestRevision(record.id), 'AGENT_STORAGE_CORRUPT');
    }
  });

  it('rejects invalid execution discriminators and optional runtime fields', () => {
    const record = storage.createAgent(makeInput());
    const path = revPath(record.id, 1);
    const valid = JSON.parse(readFileSync(path, 'utf-8')) as AgentProfileRevision;

    const invalidRevisions = [
      { ...valid, execution: {} },
      { ...valid, execution: { kind: 'external-harness' } },
      { ...valid, execution: { kind: 'external-harness', harness: 'unknown' } },
      { ...valid, execution: { kind: 'craft-backend', model: 42 } },
      { ...valid, thinkingLevel: 'ultra' },
      { ...valid, permissionMode: 'unrestricted' },
      { ...valid, enabledSourceSlugs: ['github', 42] },
    ];

    for (const bad of invalidRevisions) {
      writeFileSync(path, JSON.stringify(bad), 'utf-8');
      expectRegistryError(() => storage.loadRevision(record.id, 1), 'AGENT_PROFILE_INVALID');
    }
  });

  it('listRevisions returns revisions in ascending order', () => {
    const record = storage.createAgent(makeInput());
    storage.updateAgent(record.id, { execution: harnessExec });
    storage.updateAgent(record.id, { systemPrompt: 'Third prompt.' });

    const revisions = storage.listRevisions(record.id);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(storage.listRevisions('unknown-agent')).toEqual([]);
  });

  it('ignores orphan revision files not referenced by the pointer', () => {
    const record = storage.createAgent(makeInput());
    // Manually drop an unreferenced newer revision file (as if a crashed
    // commit left it behind before the pointer bump).
    writeFileSync(revPath(record.id, 5), JSON.stringify({ agentId: record.id, revision: 5, execution: backendExec, systemPrompt: 'orphan', createdAt: Date.now() }), 'utf-8');

    expect(storage.loadLatestRevision(record.id)?.revision).toBe(1);
    // The orphan never surfaces on the history read path.
    expect(storage.listRevisions(record.id).map((r) => r.revision)).toEqual([1]);
    // …but the physical file stays on disk (uncommitted crash leftover).
    expect(existsSync(revPath(record.id, 5))).toBe(true);
    storage.updateAgent(record.id, { execution: harnessExec });
    expect(storage.loadLatestRevision(record.id)?.revision).toBe(2);
    // Orphan 5 stays hidden while the pointer is below it…
    storage.updateAgent(record.id, { systemPrompt: 'three' });
    expect(storage.listRevisions(record.id).map((r) => r.revision)).toEqual([1, 2, 3]);
    // …and joins the visible history only once the pointer passes it.
    storage.updateAgent(record.id, { systemPrompt: 'four' });
    storage.updateAgent(record.id, { systemPrompt: 'five' });
    storage.updateAgent(record.id, { systemPrompt: 'six' });
    expect(storage.loadLatestRevision(record.id)?.revision).toBe(6);
    expect(storage.listRevisions(record.id).map((r) => r.revision)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects malicious agentIds used in file paths', () => {
    expectRegistryError(() => storage.loadRevision('../../etc/passwd', 1), 'AGENT_ID_INVALID');
    expectRegistryError(() => storage.listRevisions('../../etc/passwd'), 'AGENT_ID_INVALID');
  });
});

// ============================================================
// Lifecycle
// ============================================================

describe('lifecycle', () => {
  it('retireAgent sets status to retired and preserves identity + history', () => {
    const record = storage.createAgent(makeInput());
    storage.updateAgent(record.id, { execution: harnessExec });
    const beforeRetire = storage.getAgent(record.id)!;

    const retired = storage.retireAgent(record.id);
    expect(retired.status).toBe('retired');
    expect(retired.retiredAt).toBeGreaterThan(0);
    expect(retired.id).toBe(record.id);
    expect(retired.latestProfileRevision).toBe(2);
    expect(retired.recordVersion).toBe(beforeRetire.recordVersion + 1);
    expect(storage.listRevisions(record.id)).toHaveLength(2);
    expect(storage.getAgent(record.id)!.status).toBe('retired');
  });

  it('retireAgent is idempotent for an already-retired agent (no recordVersion bump)', () => {
    const record = storage.createAgent(makeInput());
    storage.retireAgent(record.id);
    const v = storage.getAgent(record.id)!.recordVersion;
    expect(() => storage.retireAgent(record.id)).not.toThrow();
    expect(storage.getAgent(record.id)!.recordVersion).toBe(v);
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

  it('retireAgent/restoreAgent throw AGENT_NOT_FOUND for a missing agent', () => {
    expectRegistryError(() => storage.retireAgent('missing-agent'), 'AGENT_NOT_FOUND');
    expectRegistryError(() => storage.restoreAgent('missing-agent'), 'AGENT_NOT_FOUND');
  });

  it('retire/restore never touch revisions or agent.json identity fields', () => {
    const record = storage.createAgent(makeInput());
    storage.updateAgent(record.id, { execution: harnessExec });
    const before = storage.listRevisions(record.id);

    storage.retireAgent(record.id);
    storage.restoreAgent(record.id);

    const after = storage.listRevisions(record.id);
    expect(after.map((r) => r.revision)).toEqual(before.map((r) => r.revision));
    const current = storage.getAgent(record.id)!;
    expect(current.latestProfileRevision).toBe(2);
    expect(current.id).toBe(record.id);
  });
});

// ============================================================
// Restart recovery (fresh read of the directory)
// ============================================================

describe('restart recovery (fresh directory reads)', () => {
  it('re-reads per-agent records and revisions after a simulated restart', () => {
    const record = storage.createAgent(makeInput({ id: 'restart-agent' }));
    storage.updateAgent(record.id, { systemPrompt: 'After restart.' });

    // "New process" view: every read goes to disk (no in-memory registry).
    const fresh = storage.getAgent(record.id);
    expect(fresh).not.toBeNull();
    expect(fresh!.recordVersion).toBe(2);
    expect(storage.listAgents().map((r) => r.id)).toEqual(['restart-agent']);
    expect(storage.loadLatestRevision(record.id)!.systemPrompt).toBe('After restart.');
  });
});

// ============================================================
// Invariants
// ============================================================

describe('invariants', () => {
  it('revisions never contain credentials or tokens', () => {
    const record = storage.createAgent(makeInput());
    storage.updateAgent(record.id, { execution: harnessExec });

    for (const rev of storage.listRevisions(record.id)) {
      const raw = JSON.parse(
        readFileSync(revPath(record.id, rev.revision), 'utf-8')
      );
      const json = JSON.stringify(raw).toLowerCase();
      expect(json).not.toContain('api_key');
      expect(json).not.toContain('apikey');
      expect(json).not.toContain('token');
      expect(json).not.toContain('secret');
      expect(json).not.toContain('credential');
    }
  });

  it('agent.json never contains secrets either', () => {
    const record = storage.createAgent(makeInput());
    const raw = readFileSync(join(agentDir(record.id), 'agent.json'), 'utf-8').toLowerCase();
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('api_key');
  });
});
