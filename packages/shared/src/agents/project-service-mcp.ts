/**
 * Project Service MCP Server (Issue #6)
 *
 * In-process MCP server exposing project-context tools to agent sessions.
 * Wired into ClaudeAgent's fullMcpServers only for sessions that carry an
 * agentId (agent sessions). Tools read workspace/project/agent context from
 * Craft's own data; mutation tools (report_progress/submit_result/
 * request_review/raise_issue) are acknowledged stubs — the Project Service
 * sink is a later milestone.
 *
 * Path safety: get_design resolves paths relative to the workspace root and
 * rejects any path escaping it.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { loadWorkspaceConfig } from '../workspaces/storage.ts';
import { loadWorkspaceProjects } from '../projects/storage.ts';
import { getAgent, loadLatestRevision } from './storage.ts';
import { getSessionPlansPath, listPlanFiles } from '../sessions/storage.ts';
import { debug } from '../utils/debug.ts';

export interface ProjectServiceMcpOptions {
  workspaceRootPath: string;
  agentId: string;
  sessionId: string;
}

// ============================================================
// Helpers
// ============================================================

/** Current git branch of the workspace, or null when not a git repo. */
function getGitBranch(workspaceRootPath: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workspaceRootPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a path relative to the workspace root, rejecting escapes.
 * Returns null when the path leaves the workspace root.
 */
function resolveWithinWorkspace(workspaceRootPath: string, p: string): string | null {
  const root = resolve(workspaceRootPath);
  const resolved = isAbsolute(p) ? resolve(p) : resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return null;
  }
  return resolved;
}

/** Auto-discover DESIGN.md / design/*.md at the workspace root. */
function findDesignDocs(workspaceRootPath: string): string[] {
  const found: string[] = [];
  // Dedupe by canonical path — on case-insensitive filesystems (macOS),
  // 'DESIGN.md' and 'design.md' can resolve to the same file.
  const seen = new Set<string>();
  const canonical = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const add = (candidate: string): void => {
    if (!existsSync(candidate)) return;
    const key = canonical(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(candidate);
  };

  for (const name of ['DESIGN.md', 'design.md']) {
    add(join(workspaceRootPath, name));
  }
  const designDir = join(workspaceRootPath, 'design');
  if (existsSync(designDir)) {
    try {
      for (const entry of readdirSync(designDir)) {
        if (entry.endsWith('.md')) add(join(designDir, entry));
      }
    } catch {
      // best-effort: unreadable design dir is treated as empty
    }
  }
  return found;
}

/** Read a file's contents, capped to a reasonable tool-result size. */
function readFileCapped(filePath: string, maxChars = 200_000): string {
  const content = readFileSync(filePath, 'utf-8');
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n…[truncated]`;
}

// ============================================================
// Server factory
// ============================================================

export function createProjectServiceMcpServer(
  options: ProjectServiceMcpOptions
): ReturnType<typeof createSdkMcpServer> {
  const { workspaceRootPath, agentId, sessionId } = options;

  // get_project_context — read-only workspace/project overview
  const projectContextTool = tool(
    'get_project_context',
    'Get the current workspace context: workspace identity, project list, and git branch. Use this at the start of a task to orient yourself.',
    { detailed: z.boolean().optional() },
    async () => {
      const config = loadWorkspaceConfig(workspaceRootPath);
      const projects = loadWorkspaceProjects(workspaceRootPath).map((p) => ({
        slug: p.config.slug,
        name: p.config.name,
        description: p.config.description,
      }));

      return textResult({
        workspaceRootPath,
        workspace: config
          ? { id: config.id, name: config.name, slug: config.slug }
          : null,
        projects,
        gitBranch: getGitBranch(workspaceRootPath),
      });
    }
  );

  // get_current_assignment — read-only agent identity
  const currentAssignmentTool = tool(
    'get_current_assignment',
    'Get the identity and instructions of the agent profile this session was materialized from.',
    {},
    async () => {
      const agent = getAgent(agentId);
      if (!agent) {
        return textResult({
          agentId,
          found: false,
          message: `Agent ${agentId} not found`,
        });
      }
      const revision = loadLatestRevision(agentId);
      return textResult({
        agentId: agent.id,
        found: true,
        name: agent.name,
        description: agent.description,
        status: agent.status,
        latestProfileRevision: agent.latestProfileRevision,
        executionKind: revision?.execution.kind ?? null,
        systemPrompt: revision ? truncate(revision.systemPrompt, 500) : null,
      });
    }
  );

  // get_design — read-only design document access
  const designTool = tool(
    'get_design',
    'Read design documents for the workspace. Pass a path relative to the workspace root to read a specific file, or no path to auto-discover DESIGN.md and design/*.md.',
    { path: z.string().optional() },
    async (args) => {
      if (args.path) {
        const resolved = resolveWithinWorkspace(workspaceRootPath, args.path);
        if (!resolved) {
          throw new Error(`Path "${args.path}" is outside the workspace root`);
        }
        if (!existsSync(resolved)) {
          throw new Error(`Design document not found: ${args.path}`);
        }
        return textResult({ path: args.path, content: readFileCapped(resolved) });
      }

      const docs = findDesignDocs(workspaceRootPath);
      return textResult({
        files: docs.map((filePath) => ({
          path: filePath,
          content: readFileCapped(filePath),
        })),
      });
    }
  );

  // get_plan — read-only plan listing for this session
  const planTool = tool(
    'get_plan',
    'List plan files belonging to this session.',
    {},
    async () => {
      const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
      if (!existsSync(plansDir)) return textResult({ plans: [] });
      const plans = listPlanFiles(workspaceRootPath, sessionId).map((p) => ({
        name: p.name,
        modifiedAt: p.modifiedAt,
      }));
      return textResult({ plans });
    }
  );

  // report_progress — mutation ack stub
  const progressTool = tool(
    'report_progress',
    'Report progress on the current assignment to the Project Service.',
    { progress: z.string(), percent: z.number().min(0).max(100).optional() },
    async (args) => {
      debug('[project-service] progress reported:', args);
      return textResult({ status: 'acknowledged', message: 'Progress recorded' });
    }
  );

  // submit_result — mutation ack stub
  const submitTool = tool(
    'submit_result',
    'Submit the result of the current assignment to the Project Service.',
    { summary: z.string(), artifacts: z.array(z.string()).optional() },
    async (args) => {
      debug('[project-service] result submitted:', args);
      return textResult({ status: 'acknowledged', message: 'Result submitted' });
    }
  );

  // request_review — mutation ack stub
  const reviewTool = tool(
    'request_review',
    'Request a review of the current work from the Project Service.',
    { description: z.string(), artifacts: z.array(z.string()).optional() },
    async (args) => {
      debug('[project-service] review requested:', args);
      return textResult({ status: 'acknowledged', message: 'Review requested' });
    }
  );

  // raise_issue — mutation ack stub
  const issueTool = tool(
    'raise_issue',
    'Raise an issue with the current assignment to the Project Service.',
    {
      severity: z.enum(['blocker', 'warning', 'info']),
      description: z.string(),
    },
    async (args) => {
      debug('[project-service] issue raised:', args);
      return textResult({ status: 'acknowledged', message: 'Issue recorded' });
    }
  );

  return createSdkMcpServer({
    name: 'project-service',
    version: '1.0.0',
    tools: [
      projectContextTool,
      currentAssignmentTool,
      designTool,
      planTool,
      progressTool,
      submitTool,
      reviewTool,
      issueTool,
    ],
  });
}


/** Wrap a plain result as an MCP text content block. */
function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
  };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}
