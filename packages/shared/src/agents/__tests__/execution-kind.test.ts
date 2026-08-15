/**
 * Tests for the execution-kind guard (Issue #8).
 *
 * assertSupportedExecutionKind creates the execution seam: it must be a no-op
 * for non-agent sessions, unknown agents, and craft-backend agents, and must
 * reject external-harness agents with a descriptive error.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assertSupportedExecutionKind } from '../execution-kind.ts';
import { createAgent } from '../storage.ts';

let configDir: string;

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'exec-kind-test-config-'));
  process.env.CRAFT_CONFIG_DIR = configDir;
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.CRAFT_CONFIG_DIR;
});

beforeEach(() => {
  rmSync(join(configDir, 'agents'), { recursive: true, force: true });
});

describe('assertSupportedExecutionKind', () => {
  it('no-ops when agentId is undefined (non-agent session)', () => {
    expect(() => assertSupportedExecutionKind(undefined)).not.toThrow();
  });

  it('no-ops for an unknown agent (no revision found)', () => {
    expect(() => assertSupportedExecutionKind('no-such-agent')).not.toThrow();
  });

  it('no-ops for a craft-backend agent', () => {
    const agent = createAgent({
      id: 'craft-agent',
      name: 'Craft Agent',
      execution: { kind: 'craft-backend', llmConnection: 'anthropic', model: 'claude-opus-4-8' },
      systemPrompt: 'You are a craft agent.',
    });
    expect(() => assertSupportedExecutionKind(agent.id)).not.toThrow();
  });

  it('throws with harness name and issue references for external-harness codex', () => {
    const agent = createAgent({
      id: 'codex-agent',
      name: 'Codex Agent',
      execution: { kind: 'external-harness', harness: 'codex' },
      systemPrompt: 'You are a codex agent.',
    });
    expect(() => assertSupportedExecutionKind(agent.id)).toThrow(/codex/);
    expect(() => assertSupportedExecutionKind(agent.id)).toThrow(/Issue #17/);
  });

  it('throws for external-harness claude', () => {
    const agent = createAgent({
      id: 'claude-harness-agent',
      name: 'Claude Harness Agent',
      execution: { kind: 'external-harness', harness: 'claude' },
      systemPrompt: 'You are a claude-harness agent.',
    });
    expect(() => assertSupportedExecutionKind(agent.id)).toThrow(/claude/);
    expect(() => assertSupportedExecutionKind(agent.id)).toThrow(/Issue #17/);
  });

  it('throws for external-harness kimi', () => {
    const agent = createAgent({
      id: 'kimi-agent',
      name: 'Kimi Agent',
      execution: { kind: 'external-harness', harness: 'kimi' },
      systemPrompt: 'You are a kimi agent.',
    });
    expect(() => assertSupportedExecutionKind(agent.id)).toThrow(/kimi/);
    expect(() => assertSupportedExecutionKind(agent.id)).toThrow(/Issue #17/);
  });
});
