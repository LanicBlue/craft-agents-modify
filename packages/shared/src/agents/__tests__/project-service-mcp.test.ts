/**
 * Tests for the Project Service MCP server (Issue #6).
 *
 * Tool handlers are closures inside createProjectServiceMcpServer. They are
 * exercised through the real MCP server instance: the SDK registers every
 * tool in `server.instance._registeredTools`, and `executeToolHandler(tool,
 * args)` runs the actual handler (inputSchema validation is enforced at the
 * MCP protocol layer, not by executeToolHandler).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createProjectServiceMcpServer } from '../project-service-mcp.ts';
import { createAgent } from '../storage.ts';
import { createSession } from '../../sessions/storage.ts';
import { saveProjectConfig } from '../../projects/storage.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMcpServer = any;

let configDir: string;
let ws: string;
let sessionId: string;
let agentId: string;

const EXPECTED_TOOLS = [
  'get_current_assignment',
  'get_design',
  'get_plan',
  'get_project_context',
  'raise_issue',
  'report_progress',
  'request_review',
  'submit_result',
].sort();

function makeServer(agent: string): AnyMcpServer {
  return createProjectServiceMcpServer({
    workspaceRootPath: ws,
    agentId: agent,
    sessionId,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runTool(server: AnyMcpServer, name: string, args: any): Promise<any> {
  const toolObj = server.instance._registeredTools[name];
  const res = await server.instance.executeToolHandler(toolObj, args);
  return JSON.parse(res.content[0].text);
}

beforeAll(async () => {
  // Global agents registry isolation
  configDir = mkdtempSync(join(tmpdir(), 'psmcp-test-config-'));
  process.env.CRAFT_CONFIG_DIR = configDir;
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.CRAFT_CONFIG_DIR;
});

beforeEach(async () => {
  rmSync(join(configDir, 'agents'), { recursive: true, force: true });
  ws = mkdtempSync(join(tmpdir(), 'psmcp-test-ws-'));

  // Workspace config
  mkdirSync(join(ws, '.craft-agent'), { recursive: true });
  writeFileSync(
    join(ws, '.craft-agent', 'workspace.json'),
    JSON.stringify({ id: 'ws-psmcp-1', name: 'PSMCP Workspace', slug: 'psmcp-workspace' }),
    'utf-8'
  );

  // A project
  mkdirSync(join(ws, '.craft-agent', 'projects'), { recursive: true });
  saveProjectConfig(ws, {
    id: 'proj-1',
    slug: 'alpha',
    name: 'Alpha Project',
    description: 'The alpha project',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  // An agent
  const agent = createAgent({
    name: 'PSMCP Agent',
    description: 'Project service test agent',
    execution: { kind: 'craft-backend', llmConnection: 'anthropic', model: 'claude-opus-4-8' },
    systemPrompt: 'You are the project service agent.',
    thinkingLevel: 'high',
    permissionMode: 'ask',
    enabledSourceSlugs: ['github'],
  });
  agentId = agent.id;

  // Session + plan file
  const session = await createSession(ws, { name: 'psmcp session' });
  sessionId = session.id;
  const plansDir = join(ws, '.craft-agent', 'sessions', sessionId, 'plans');
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(join(plansDir, '2024-01-01-plan.md'), '# Plan', 'utf-8');

  // Design doc
  writeFileSync(join(ws, 'DESIGN.md'), '# Design\n\nThis is the design.', 'utf-8');
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('Project Service MCP server creation', () => {
  it('registers exactly the 8 project-service tools', () => {
    const server = makeServer(agentId);
    const names = Object.keys(server.instance._registeredTools).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
  });
});

describe('get_project_context', () => {
  it('returns workspace info, project list, and git branch field', async () => {
    const server = makeServer(agentId);
    const ctx = await runTool(server, 'get_project_context', {});

    expect(ctx.workspaceRootPath).toBe(ws);
    expect(ctx.workspace).toEqual({ id: 'ws-psmcp-1', name: 'PSMCP Workspace', slug: 'psmcp-workspace' });
    expect(ctx.projects).toHaveLength(1);
    expect(ctx.projects[0]).toMatchObject({ slug: 'alpha', name: 'Alpha Project', description: 'The alpha project' });
    expect('gitBranch' in ctx).toBe(true);
  });
});

describe('get_current_assignment', () => {
  it('returns the agent identity for a known agent', async () => {
    const server = makeServer(agentId);
    const assign = await runTool(server, 'get_current_assignment', {});

    expect(assign.found).toBe(true);
    expect(assign.agentId).toBe(agentId);
    expect(assign.name).toBe('PSMCP Agent');
    expect(assign.description).toBe('Project service test agent');
    expect(assign.status).toBe('active');
    expect(assign.executionKind).toBe('craft-backend');
    expect(assign.systemPrompt).toBe('You are the project service agent.');
  });

  it('returns found:false for an unknown agent (no throw)', async () => {
    const server = makeServer('agent_deadbeef');
    const assign = await runTool(server, 'get_current_assignment', {});
    expect(assign.found).toBe(false);
    expect(assign.agentId).toBe('agent_deadbeef');
  });
});

describe('get_design', () => {
  it('reads a design doc by explicit relative path', async () => {
    const server = makeServer(agentId);
    const design = await runTool(server, 'get_design', { path: 'DESIGN.md' });
    expect(design.path).toBe('DESIGN.md');
    expect(design.content).toContain('This is the design.');
  });

  it('rejects path traversal outside the workspace root', async () => {
    const server = makeServer(agentId);
    await expect(runTool(server, 'get_design', { path: '../../../etc/passwd' })).rejects.toThrow();
  });

  it('rejects absolute paths outside the workspace root', async () => {
    const server = makeServer(agentId);
    await expect(runTool(server, 'get_design', { path: '/etc/passwd' })).rejects.toThrow();
  });

  it('throws for a non-existent path', async () => {
    const server = makeServer(agentId);
    await expect(runTool(server, 'get_design', { path: 'missing.md' })).rejects.toThrow(/not found/);
  });

  it('auto-discovers DESIGN.md when no path is given', async () => {
    const server = makeServer(agentId);
    const discovered = await runTool(server, 'get_design', {});
    expect(discovered.files).toHaveLength(1);
    expect(discovered.files[0].path).toContain('DESIGN.md');
  });
});

describe('get_plan', () => {
  it('lists plan files from the session plans directory', async () => {
    const server = makeServer(agentId);
    const plan = await runTool(server, 'get_plan', {});
    expect(plan.plans).toHaveLength(1);
    expect(plan.plans[0].name).toBe('2024-01-01-plan');
  });
});

describe('mutation tools', () => {
  it('report_progress acknowledges', async () => {
    const server = makeServer(agentId);
    expect(await runTool(server, 'report_progress', { progress: '50%', percent: 50 })).toEqual({
      status: 'acknowledged',
      message: 'Progress recorded',
    });
  });

  it('submit_result acknowledges', async () => {
    const server = makeServer(agentId);
    expect(await runTool(server, 'submit_result', { summary: 'done', artifacts: ['a.txt'] })).toEqual({
      status: 'acknowledged',
      message: 'Result submitted',
    });
  });

  it('request_review acknowledges', async () => {
    const server = makeServer(agentId);
    expect(await runTool(server, 'request_review', { description: 'please review' })).toEqual({
      status: 'acknowledged',
      message: 'Review requested',
    });
  });

  it('raise_issue acknowledges', async () => {
    const server = makeServer(agentId);
    expect(await runTool(server, 'raise_issue', { severity: 'warning', description: 'late' })).toEqual({
      status: 'acknowledged',
      message: 'Issue recorded',
    });
  });
});
