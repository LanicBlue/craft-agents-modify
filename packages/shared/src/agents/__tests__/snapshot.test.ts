/**
 * Tests for resolveAgentSnapshot — resolution of an immutable
 * AgentProfileSnapshot from an AgentProfileRevision (Issue #3).
 */

import { describe, it, expect } from 'bun:test';
import { resolveAgentSnapshot } from '../storage.ts';
import type { AgentProfileRevision } from '../types.ts';

function makeRevision(overrides: Partial<AgentProfileRevision> = {}): AgentProfileRevision {
  return {
    agentId: 'agent_12345678',
    revision: 3,
    execution: { kind: 'craft-backend', llmConnection: 'anthropic', model: 'claude-opus-4-8' },
    thinkingLevel: 'max',
    permissionMode: 'ask',
    systemPrompt: 'You are a test agent.',
    enabledSourceSlugs: ['github', 'linear'],
    createdAt: 1,
    ...overrides,
  };
}

describe('resolveAgentSnapshot', () => {
  it('extracts execution, systemPrompt, and model from a full revision', () => {
    const snapshot = resolveAgentSnapshot(makeRevision());

    expect(snapshot.execution).toEqual({
      kind: 'craft-backend',
      llmConnection: 'anthropic',
      model: 'claude-opus-4-8',
    });
    expect(snapshot.model).toBe('claude-opus-4-8');
    expect(snapshot.systemPrompt).toBe('You are a test agent.');
  });

  it('inherits present optional fields (thinkingLevel/permissionMode/enabledSourceSlugs)', () => {
    const snapshot = resolveAgentSnapshot(makeRevision());

    expect(snapshot.thinkingLevel).toBe('max');
    expect(snapshot.permissionMode).toBe('ask');
    expect(snapshot.enabledSourceSlugs).toEqual(['github', 'linear']);
  });

  it('omits optional fields that are absent from the revision', () => {
    const snapshot = resolveAgentSnapshot(
      makeRevision({
        thinkingLevel: undefined,
        permissionMode: undefined,
        enabledSourceSlugs: undefined,
        execution: { kind: 'craft-backend' },
      })
    );

    expect('thinkingLevel' in snapshot).toBe(false);
    expect('permissionMode' in snapshot).toBe(false);
    expect('enabledSourceSlugs' in snapshot).toBe(false);
    expect(snapshot.model).toBeUndefined();
    // Required fields always present
    expect(snapshot.execution.kind).toBe('craft-backend');
    expect(snapshot.systemPrompt).toBe('You are a test agent.');
  });

  it('preserves external-harness execution config', () => {
    const snapshot = resolveAgentSnapshot(
      makeRevision({
        execution: { kind: 'external-harness', harness: 'codex', model: 'gpt-5', configMode: 'managed' },
      })
    );

    expect(snapshot.execution).toEqual({
      kind: 'external-harness',
      harness: 'codex',
      model: 'gpt-5',
      configMode: 'managed',
    });
    expect(snapshot.model).toBe('gpt-5');
  });

  it('leaves model undefined when the execution config has no model', () => {
    const snapshot = resolveAgentSnapshot(
      makeRevision({
        execution: { kind: 'external-harness', harness: 'kimi' },
      })
    );

    expect('model' in snapshot).toBe(false);
    expect(snapshot.execution.kind).toBe('external-harness');
  });
});
