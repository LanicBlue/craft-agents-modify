/**
 * HarnessEvent → AgentEvent normalization tests (Issue #9 Step 4)
 */

import { describe, expect, test } from 'bun:test';
import { normalizeHarnessEvent } from '../external-harness-backend.ts';
import type { HarnessEvent } from '../types.ts';

describe('normalizeHarnessEvent', () => {
  test('text_delta maps to AgentEvent text_delta', () => {
    const event: HarnessEvent = { type: 'text_delta', text: 'hello' };
    expect(normalizeHarnessEvent(event)).toEqual({ type: 'text_delta', text: 'hello' });
  });

  test('text_complete maps to AgentEvent text_complete', () => {
    const event: HarnessEvent = { type: 'text_complete', text: 'done' };
    expect(normalizeHarnessEvent(event)).toEqual({ type: 'text_complete', text: 'done' });
  });

  test('tool_start maps to AgentEvent tool_start with input', () => {
    const event: HarnessEvent = {
      type: 'tool_start',
      toolName: 'bash',
      toolUseId: 'tu-1',
      input: { command: 'ls' },
    };
    expect(normalizeHarnessEvent(event)).toEqual({
      type: 'tool_start',
      toolName: 'bash',
      toolUseId: 'tu-1',
      input: { command: 'ls' },
    });
  });

  test('tool_result maps to AgentEvent tool_result with isError', () => {
    const event: HarnessEvent = {
      type: 'tool_result',
      toolUseId: 'tu-1',
      toolName: 'bash',
      result: 'ok',
      isError: false,
    };
    expect(normalizeHarnessEvent(event)).toEqual({
      type: 'tool_result',
      toolUseId: 'tu-1',
      toolName: 'bash',
      result: 'ok',
      isError: false,
    });
  });

  test('permission_request maps to AgentEvent permission_request', () => {
    const event: HarnessEvent = {
      type: 'permission_request',
      requestId: 'pr-1',
      toolName: 'bash',
      description: 'Run command',
      command: 'rm -rf /tmp/x',
    };
    expect(normalizeHarnessEvent(event)).toEqual({
      type: 'permission_request',
      requestId: 'pr-1',
      toolName: 'bash',
      description: 'Run command',
      command: 'rm -rf /tmp/x',
    });
  });

  test('error maps to AgentEvent error', () => {
    const event: HarnessEvent = { type: 'error', message: 'boom' };
    expect(normalizeHarnessEvent(event)).toEqual({ type: 'error', message: 'boom' });
  });

  test('complete maps to AgentEvent complete with usage', () => {
    const event: HarnessEvent = {
      type: 'complete',
      usage: { inputTokens: 10, outputTokens: 20 },
    };
    expect(normalizeHarnessEvent(event)).toEqual({
      type: 'complete',
      usage: { inputTokens: 10, outputTokens: 20 },
    });
  });

  test('complete without usage maps to AgentEvent complete', () => {
    const event: HarnessEvent = { type: 'complete' };
    expect(normalizeHarnessEvent(event)).toEqual({ type: 'complete', usage: undefined });
  });
});
