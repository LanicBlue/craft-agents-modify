/**
 * Harness Driver Registry tests (Issue #9 Step 4)
 */

import { describe, expect, test } from 'bun:test';
import {
  getHarnessDriver,
  getRegisteredHarnessTypes,
  registerHarnessDriver,
} from '../registry.ts';
import type { HarnessDriver } from '../types.ts';

const codexDriver: HarnessDriver = {
  harness: 'codex',
  create: async () => ({ nativeSessionId: 'x', managed: true }),
  resume: async () => ({ nativeSessionId: 'x', managed: true }),
  run: async function* () {},
  stop: async () => {},
};

const claudeDriver: HarnessDriver = {
  harness: 'claude',
  create: async () => ({ nativeSessionId: 'y', managed: true }),
  resume: async () => ({ nativeSessionId: 'y', managed: true }),
  run: async function* () {},
  stop: async () => {},
};

describe('harness driver registry', () => {
  test('register + get returns the same driver instance', () => {
    registerHarnessDriver(codexDriver);
    expect(getHarnessDriver('codex')).toBe(codexDriver);
  });

  test('get unregistered harness returns undefined', () => {
    expect(getHarnessDriver('kimi')).toBeUndefined();
  });

  test('getRegisteredHarnessTypes lists registered harnesses', () => {
    registerHarnessDriver(claudeDriver);
    const types = getRegisteredHarnessTypes();
    expect(types).toContain('codex');
    expect(types).toContain('claude');
  });
});
