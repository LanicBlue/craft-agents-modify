/**
 * Gate A craft-backend real-dispatch integration test (rework Step 2).
 *
 * Proves an AGENT session with execution.kind === 'craft-backend' dispatches
 * through the REAL SessionManager.sendMessage → getOrCreateAgent regular path
 * (resolveBackendContext → connection lock → MCP pool → factory seam) and
 * persists to disk — with zero production code changes.
 *
 * The only seam mocked is the module 'createBackendFromResolvedContext'
 * factory entry (and its resolveBackendContext feeder), replaced by a minimal
 * AgentBackend whose chat emits text_delta → text_complete → complete.
 * All other real exports of the module are spread through from the real
 * source files via deep imports (bypassing the mocked barrel).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Real implementations for everything except the two mocked seam entries.
// Deep imports bypass the mocked barrel; a SYNCHRONOUS factory is required —
// re-export bindings (e.g. shared/agent's AbortReason-as-BackendAbortReason)
// are validated at link time, before any async factory promise could resolve.
import * as backendFactory from '@craft-agent/shared/agent/backend/factory';
import * as backendTypes from '@craft-agent/shared/agent/backend/types';
import * as backendEventQueue from '@craft-agent/shared/agent/backend/event-queue';
import * as backendBaseAdapter from '@craft-agent/shared/agent/backend/base-event-adapter';
import * as backendClaudeAdapter from '@craft-agent/shared/agent/backend/claude/event-adapter';
import * as backendPiAdapter from '@craft-agent/shared/agent/backend/pi/event-adapter';
import * as harnessTypes from '@craft-agent/shared/agent/backend/harness/types';
import * as harnessRegistry from '@craft-agent/shared/agent/backend/harness/registry';

// ---------------------------------------------------------------------------
// Mock the backend factory seam (must run before SessionManager is imported)
// ---------------------------------------------------------------------------

const createdBackends: Array<{
  context: { provider: string; resolvedModel: string };
  coreConfig: {
    workspace: { id: string; rootPath: string };
    thinkingLevel?: string;
    session?: { id: string; agentId?: string; model?: string; permissionMode?: string };
    initialSources?: { enabledSlugs: string[] };
  };
}> = [];

function makeMockAgent() {
  return {
    backendName: 'MockCraftBackend',
    supportsBranching: true,
    onDebug: undefined as ((msg: string) => void) | undefined,
    onBackendAuthRequired: undefined as ((reason: string) => void) | undefined,
    onPermissionRequest: undefined,
    postInit: async () => ({ authInjected: true }),
    chat: async function* () {
      yield { type: 'text_delta', text: 'hello from craft mock' };
      yield { type: 'text_complete', text: 'hello from craft mock' };
      yield { type: 'complete', usage: { inputTokens: 5, outputTokens: 3 } };
    },
    // Full AgentBackend surface — no-op stubs so the real dispatch path
    // never trips on a missing method.
    abort: async () => {},
    forceAbort: () => {},
    setBackgroundEventSink: () => {},
    interruptForHandoff: () => {},
    redirect: () => false,
    runMiniCompletion: async () => null,
    destroy: () => {},
    dispose: () => {},
    applyBridgeUpdates: async () => {},
    ensureBranchReady: async () => {},
    isProcessing: () => false,
    getModel: () => 'mock-model',
    setModel: () => {},
    updateRuntimeConfig: async () => true,
    disposeForRestart: async () => {},
    getThinkingLevel: () => 'medium',
    setThinkingLevel: () => {},
    getPermissionMode: () => 'ask',
    setPermissionMode: () => {},
    cyclePermissionMode: () => 'ask',
    getSessionId: () => null,
    generateTitle: async () => null,
    regenerateTitle: async () => null,
    getCurrentTurnUserMessage: () => null,
    setPendingSourceActivationRestart: () => {},
    getActiveSourceSlugs: () => [],
    getAllSources: () => [],
    setAllSources: () => {},
    setSourceServers: async () => {},
    markSourceUnseen: () => {},
    getSummarizeCallback: () => async () => null,
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
  };
}

mock.module('@craft-agent/shared/agent/backend', () => ({
  ...backendFactory,
  ...backendTypes,
  ...backendEventQueue,
  ...backendBaseAdapter,
  ...backendClaudeAdapter,
  ...backendPiAdapter,
  ...harnessTypes,
  ...harnessRegistry,
    // Mocked seam: provider-agnostic resolution returns a fixed context.
    resolveBackendContext: () => ({
      connection: null,
      provider: 'anthropic' as const,
      authType: undefined,
      resolvedModel: 'mock-model',
      capabilities: { needsHttpPoolServer: false },
    }),
    // Mocked seam: record creation args, return the minimal AgentBackend.
    createBackendFromResolvedContext: (args: {
      context: { provider: string; resolvedModel: string };
      coreConfig: {
        workspace: { id: string; rootPath: string };
        thinkingLevel?: string;
        session?: { id: string; agentId?: string; model?: string; permissionMode?: string };
        initialSources?: { enabledSlugs: string[] };
      };
      hostRuntime: unknown;
    }) => {
      createdBackends.push(args);
      return makeMockAgent();
    },
}));

// ---------------------------------------------------------------------------

import { SessionManager, setSessionPlatform } from './SessionManager.ts';
import { CONSOLE_LOGGER } from '@craft-agent/server-core/runtime';
import { createAgent, ensureAgentSession } from '@craft-agent/shared/agents';
import { loadSession, sessionPersistenceQueue } from '@craft-agent/shared/sessions';
import type { Workspace } from '@craft-agent/shared/config';

let configDir: string;
let wsRoot: string;

const workspace: Workspace = {
  id: 'ws_craft_a',
  name: 'Craft A Workspace',
  slug: 'craft-a-workspace',
  rootPath: '',
  createdAt: Date.now(),
};

function makeAgent(name: string) {
  return createAgent({
    name,
    execution: { kind: 'craft-backend', llmConnection: 'anthropic', model: 'claude-opus-4-8' },
    systemPrompt: 'You are the craft-backend agent.',
    thinkingLevel: 'max',
    permissionMode: 'ask',
  });
}

function agentRef(managed: { agent: unknown } | null) {
  return (managed as unknown as { agent: { destroy(): void } | null } | null)?.agent ?? null;
}

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'gate-a-craft-config-'));
  process.env.CRAFT_CONFIG_DIR = configDir;
  wsRoot = mkdtempSync(join(tmpdir(), 'gate-a-craft-ws-'));
  workspace.rootPath = wsRoot;
  // The craft create path builds a BackendHostRuntimeContext via
  // buildBackendHostRuntimeContext(), which requires the platform ref.
  setSessionPlatform({
    appRootPath: wsRoot,
    resourcesPath: wsRoot,
    isPackaged: false,
    appVersion: 'test',
    imageProcessor: {
      getMetadata: async () => ({ width: 1, height: 1 }),
      process: async (input: Buffer | string) =>
        typeof input === 'string' ? Buffer.from('') : input,
    },
    logger: CONSOLE_LOGGER,
    isDebugMode: false,
  });
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(wsRoot, { recursive: true, force: true });
  delete process.env.CRAFT_CONFIG_DIR;
});

beforeEach(() => {
  createdBackends.length = 0;
});

describe('Gate A: craft-backend real dispatch', () => {
  it('materializes → adopts → dispatches through the real craft path and persists to disk', async () => {
    const agent = makeAgent('Craft A Dispatch Agent');
    const session = await ensureAgentSession(wsRoot, workspace.id, agent.id);
    expect(session.agentId).toBe(agent.id);
    expect(session.agentProfileSnapshot?.execution.kind).toBe('craft-backend');

    const sm = new SessionManager();
    const managed = sm.adoptPersistedSession(workspace, session.id);
    expect(managed).not.toBeNull();

    try {
      await sm.sendMessage(session.id, 'hello craft backend');
      await sessionPersistenceQueue.flush(session.id);

      const after = loadSession(wsRoot, session.id);
      expect(after).not.toBeNull();
      const texts = after!.messages.map((m) => m.content ?? '');
      expect(texts.some((t) => t.includes('hello craft backend'))).toBe(true);
      expect(texts.some((t) => t.includes('hello from craft mock'))).toBe(true);
      // Session carries agent identity + snapshot on disk.
      expect(after!.agentId).toBe(agent.id);
      expect(after!.agentProfileRevision).toBe(1);
      expect(after!.agentProfileSnapshot).toEqual(session.agentProfileSnapshot);
    } finally {
      agentRef(managed)?.destroy();
    }
  });

  it('mock backend receives the snapshot-derived configuration (revision 1 snapshot)', async () => {
    const agent = makeAgent('Craft A Config Agent');
    const session = await ensureAgentSession(wsRoot, workspace.id, agent.id);

    const sm = new SessionManager();
    const managed = sm.adoptPersistedSession(workspace, session.id);
    try {
      await sm.sendMessage(session.id, 'probe config');
      await sessionPersistenceQueue.flush(session.id);
    } finally {
      agentRef(managed)?.destroy();
    }

    // The factory seam saw exactly one creation with the snapshot-derived fields.
    expect(createdBackends.length).toBe(1);
    const { context, coreConfig } = createdBackends[0];
    // resolveBackendContext (mocked feeder) was consumed by the craft path.
    expect(context.provider).toBe('anthropic');
    expect(context.resolvedModel).toBe('mock-model');
    // #3 snapshot-derived config flows into the backend creation args.
    expect(coreConfig.session?.agentId).toBe(agent.id);
    expect(coreConfig.session?.permissionMode).toBe('ask');
    expect(coreConfig.thinkingLevel).toBe('max');
    expect(coreConfig.session?.model).toBe('claude-opus-4-8');
    // Workspace + session identity wiring.
    expect(coreConfig.workspace.rootPath).toBe(wsRoot);
    expect(coreConfig.session?.id).toBe(session.id);
  });

  it('second dispatch reuses the same backend instance (no re-creation)', async () => {
    const agent = makeAgent('Craft A Reuse Agent');
    const session = await ensureAgentSession(wsRoot, workspace.id, agent.id);

    const sm = new SessionManager();
    const managed = sm.adoptPersistedSession(workspace, session.id);
    try {
      await sm.sendMessage(session.id, 'first');
      await sessionPersistenceQueue.flush(session.id);
      await sm.sendMessage(session.id, 'second');
      await sessionPersistenceQueue.flush(session.id);
    } finally {
      agentRef(managed)?.destroy();
    }

    // getOrCreateAgent returns the live agent for the second turn — the
    // factory seam was hit exactly once.
    expect(createdBackends.length).toBe(1);
    const after = loadSession(wsRoot, session.id);
    expect(after!.messages.length).toBeGreaterThan(3);
  });

  it('restart: fresh SessionManager adopts and re-creates the backend for the same session', async () => {
    const agent = makeAgent('Craft A Restart Agent');
    const session = await ensureAgentSession(wsRoot, workspace.id, agent.id);

    const sm1 = new SessionManager();
    const managed1 = sm1.adoptPersistedSession(workspace, session.id);
    try {
      await sm1.sendMessage(session.id, 'incarnation one');
      await sessionPersistenceQueue.flush(session.id);
    } finally {
      agentRef(managed1)?.destroy();
    }
    expect(createdBackends.length).toBe(1);

    // Fresh SessionManager: no in-memory agent — the craft path creates a new
    // backend instance for the SAME canonical session (resume/reuse of id).
    const sm2 = new SessionManager();
    const managed2 = sm2.adoptPersistedSession(workspace, session.id);
    try {
      await sm2.sendMessage(session.id, 'incarnation two');
      await sessionPersistenceQueue.flush(session.id);
    } finally {
      agentRef(managed2)?.destroy();
    }

    expect(createdBackends.length).toBe(2);
    expect(createdBackends[1].coreConfig.session?.id).toBe(session.id);
    expect(createdBackends[1].coreConfig.session?.agentId).toBe(agent.id);
    const after = loadSession(wsRoot, session.id);
    expect(after!.id).toBe(session.id);
    const texts = after!.messages.map((m) => m.content ?? '');
    expect(texts.some((t) => t.includes('incarnation one'))).toBe(true);
    expect(texts.some((t) => t.includes('incarnation two'))).toBe(true);
  });
});
