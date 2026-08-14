import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { resolveAutomationsConfigPath } from './resolve-config-path.ts';
import { AUTOMATIONS_CONFIG_FILE } from './constants.ts';
import { WORKSPACE_NAMESPACE } from '../workspaces/storage.ts';

describe('resolve-config-path', () => {
  it('returns automations.json path for workspace root', () => {
    const root = '/tmp/test-workspace';
    expect(resolveAutomationsConfigPath(root)).toBe(join(root, WORKSPACE_NAMESPACE, AUTOMATIONS_CONFIG_FILE));
  });
});
