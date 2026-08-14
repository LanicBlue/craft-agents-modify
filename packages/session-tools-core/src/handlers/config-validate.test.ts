import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleConfigValidate } from './config-validate.ts';

// Workspace namespace for Craft-owned workspace-local metadata.
// Must stay in sync with WORKSPACE_NAMESPACE in
// packages/shared/src/workspaces/storage.ts (this package cannot import shared).
const WORKSPACE_NAMESPACE = '.craft-agent';

function createCtx(workspacePath: string) {
  return {
    sessionId: 'test-session',
    workspacePath,
    get sourcesPath() { return join(workspacePath, WORKSPACE_NAMESPACE, 'sources'); },
    get skillsPath() { return join(workspacePath, WORKSPACE_NAMESPACE, 'skills'); },
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    },
    fs: {
      exists: (path: string) => existsSync(path),
      readFile: (path: string) => readFileSync(path, 'utf-8'),
      readFileBuffer: (path: string) => readFileSync(path),
      writeFile: (path: string, content: string) => writeFileSync(path, content),
      isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
      readdir: (path: string) => readdirSync(path),
      stat: (path: string) => {
        const s = statSync(path);
        return { size: s.size, isDirectory: () => s.isDirectory() };
      },
    },
    validators: undefined,
    loadSourceConfig: () => null,
  } as const;
}

describe('config-validate automations target', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-validate-automations-test-'));
    mkdirSync(join(tempDir, WORKSPACE_NAMESPACE), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates automations.json when present', async () => {
    writeFileSync(join(tempDir, WORKSPACE_NAMESPACE, 'automations.json'), JSON.stringify({ version: 2, automations: {} }));

    const result = await handleConfigValidate(createCtx(tempDir), { target: 'automations' });
    expect(result.content[0]?.text).toContain('Validation passed');
  });

  it('returns no-config message when automations.json does not exist', async () => {
    const result = await handleConfigValidate(createCtx(tempDir), { target: 'automations' });
    expect(result.content[0]?.text).toContain('No automations.json');
  });
});
