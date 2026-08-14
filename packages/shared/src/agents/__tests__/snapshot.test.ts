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

  it('resolves hardcoded defaults for fields absent from the revision', () => {
    const snapshot = resolveAgentSnapshot(
      makeRevision({
        thinkingLevel: undefined,
        permissionMode: undefined,
        enabledSourceSlugs: undefined,
        execution: { kind: 'craft-backend' },
      })
    );

    // Resolution chain: revision > workspace defaults > hardcoded globals.
    expect(snapshot.permissionMode).toBe('ask');
    expect(snapshot.thinkingLevel).toBe('medium');
    expect('enabledSourceSlugs' in snapshot).toBe(false);
    expect('model' in snapshot).toBe(false);
    expect('llmConnection' in snapshot).toBe(false);
    expect(typeof snapshot.resolvedAt).toBe('number');
    // Required fields always present
    expect(snapshot.execution.kind).toBe('craft-backend');
    expect(snapshot.systemPrompt).toBe('You are a test agent.');
  });

  it('resolves workspace defaults when the revision omits fields (R1a)', () => {
    const snapshot = resolveAgentSnapshot(
      makeRevision({
        thinkingLevel: undefined,
        permissionMode: undefined,
        enabledSourceSlugs: undefined,
        execution: { kind: 'craft-backend' },
      }),
      {
        permissionMode: 'allow-all',
        thinkingLevel: 'high',
        model: 'claude-3-7-sonnet',
        defaultLlmConnection: 'workspace-conn',
        enabledSourceSlugs: ['github'],
      }
    );

    expect(snapshot.permissionMode).toBe('allow-all');
    expect(snapshot.thinkingLevel).toBe('high');
    expect(snapshot.model).toBe('claude-3-7-sonnet');
    expect(snapshot.llmConnection).toBe('workspace-conn');
    expect(snapshot.enabledSourceSlugs).toEqual(['github']);
  });

  it('revision values win over workspace defaults', () => {
    const snapshot = resolveAgentSnapshot(
      makeRevision(), // revision already has thinkingLevel 'max' / permissionMode 'ask' / sources
      {
        permissionMode: 'allow-all',
        thinkingLevel: 'low',
        model: 'claude-3-7-sonnet',
        enabledSourceSlugs: ['linear'],
      }
    );

    expect(snapshot.permissionMode).toBe('ask');
    expect(snapshot.thinkingLevel).toBe('max');
    expect(snapshot.enabledSourceSlugs).toEqual(['github', 'linear']);
    // model: revision execution model wins over the workspace default.
    expect(snapshot.model).toBe('claude-opus-4-8');
  });

  it('preserves explicit [] over workspace default sources (R1a)', () => {
    const snapshot = resolveAgentSnapshot(
      makeRevision({ enabledSourceSlugs: [] }),
      { enabledSourceSlugs: ['github'] }
    );

    expect(snapshot.enabledSourceSlugs).toEqual([]);
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
