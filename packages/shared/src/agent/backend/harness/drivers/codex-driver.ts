/**
 * Codex Harness Driver (Issue #10)
 *
 * HarnessDriver implementation for the Codex CLI, following the PiAgent
 * subprocess pattern (JSONL over stdio).
 *
 * Protocol contract (Codex subprocess ↔ Craft):
 *
 * INBOUND (Craft → Codex, one JSON object per line on stdin):
 *   { "type": "init", "systemPrompt": "...", "model": "...",
 *     "workingDirectory": "...", "nativeSessionId": "..." (resume only) }
 *   { "type": "message", "text": "user message" }
 *   { "type": "interrupt" }
 *   { "type": "shutdown" }
 *
 * OUTBOUND (Codex → Craft, one JSON object per line on stdout):
 *   { "type": "ready", "sessionId": "codex-xxx" }
 *   { "type": "text_delta", "text": "..." }
 *   { "type": "text_complete", "text": "..." }
 *   { "type": "tool_start", "toolName": "...", "toolUseId": "...", "input": {...} }
 *   { "type": "tool_result", "toolUseId": "...", "result": "...", "isError": false }
 *   { "type": "permission_request", "requestId": "...", "toolName": "...", "description": "..." }
 *   { "type": "error", "message": "..." }
 *   { "type": "done", "usage": { "inputTokens": N, "outputTokens": N } }
 *
 * Lifecycle semantics:
 * - create()/resume() spawn the subprocess, send init, and await the ready
 *   handshake. The received sessionId is the nativeSessionId (Craft-side
 *   implementation truth, never exposed as workflow identity — ADR #9).
 * - run() sends a message and streams events until done (→ complete).
 * - interrupt() sends interrupt; the subprocess acknowledges with done.
 * - stop() sends shutdown, then escalates SIGTERM → SIGKILL on timeout.
 *
 * Busy/queue/concurrent-dispatch semantics are owned by
 * ExternalHarnessBackend + SessionManager (Issue #9), NOT this driver.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type {
  HarnessCreateArgs,
  HarnessDriver,
  HarnessEvent,
  HarnessResumeArgs,
  HarnessSession,
  HarnessType,
} from '../types.ts';
import { debug } from '../../../../utils/debug.ts';

export interface CodexDriverConfig {
  /** Command to invoke (default: 'codex') */
  command?: string;
  /** Args for the command (default: ['--json-mode']) */
  args?: string[];
  /** Additional env vars */
  env?: Record<string, string>;
  /** How long to wait for the ready handshake (default: 30s) */
  readyTimeoutMs?: number;
  /** Grace window for shutdown before escalating signals (default: 2s) */
  shutdownTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const FINAL_KILL_TIMEOUT_MS = 2_000;

/** Per-subprocess state tracked by the driver. */
interface CodexProcess {
  child: ChildProcess;
  readline: ReadlineInterface;
  readyPromise: Promise<void>;
  readyResolve: () => void;
  readyReject: (err: Error) => void;
  readyTimer?: ReturnType<typeof setTimeout>;
  readySettled: boolean;
  /** Native session id assigned by the subprocess ready handshake */
  sessionId?: string;
  exited: boolean;
  shutdownRequested: boolean;
  activeRun?: {
    push: (event: HarnessEvent) => void;
    end: () => void;
  };
}

/**
 * Convert a raw JSONL line from the codex subprocess into a HarnessEvent
 * (or the internal ready handshake). Returns null for unknown/malformed lines.
 */
function parseCodexEvent(line: string): HarnessEvent | { type: 'ready'; sessionId: string } | null {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (msg.type) {
    case 'text_delta':
      return { type: 'text_delta', text: String(msg.text ?? '') };
    case 'text_complete':
      return { type: 'text_complete', text: String(msg.text ?? '') };
    case 'tool_start':
      return {
        type: 'tool_start',
        toolName: String(msg.toolName ?? ''),
        toolUseId: String(msg.toolUseId ?? ''),
        input: (msg.input as Record<string, unknown>) ?? {},
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: String(msg.toolUseId ?? ''),
        ...(msg.toolName !== undefined ? { toolName: String(msg.toolName) } : {}),
        result: String(msg.result ?? ''),
        isError: msg.isError === true,
      };
    case 'permission_request':
      return {
        type: 'permission_request',
        requestId: String(msg.requestId ?? ''),
        toolName: String(msg.toolName ?? ''),
        description: String(msg.description ?? ''),
        ...(msg.command !== undefined ? { command: String(msg.command) } : {}),
      };
    case 'error':
      return { type: 'error', message: String(msg.message ?? '') };
    case 'done':
      return {
        type: 'complete',
        usage:
          msg.usage && typeof msg.usage === 'object'
            ? {
                inputTokens: Number((msg.usage as { inputTokens?: unknown }).inputTokens ?? 0),
                outputTokens: Number((msg.usage as { outputTokens?: unknown }).outputTokens ?? 0),
              }
            : undefined,
      };
    case 'ready':
      return { type: 'ready', sessionId: String(msg.sessionId ?? '') };
    default:
      return null;
  }
}

export class CodexDriver implements HarnessDriver {
  readonly harness: HarnessType = 'codex';

  private readonly config: Required<Pick<CodexDriverConfig, 'command' | 'args'>> &
    CodexDriverConfig;

  /** Native session id → subprocess state */
  private readonly processes = new Map<string, CodexProcess>();
  /** Pre-ready spawns (native session id not yet known) */
  private readonly pendingSpawns = new Set<CodexProcess>();

  constructor(config: CodexDriverConfig = {}) {
    this.config = {
      command: config.command ?? 'codex',
      args: config.args ?? ['--json-mode'],
      ...config,
    };
  }

  async create(args: HarnessCreateArgs): Promise<HarnessSession> {
    return this.spawnAndInit(args, undefined);
  }

  async resume(args: HarnessResumeArgs): Promise<HarnessSession> {
    return this.spawnAndInit(args, args.nativeSessionId);
  }

  async *run(session: HarnessSession, message: string): AsyncGenerator<HarnessEvent> {
    const proc = this.processes.get(session.nativeSessionId);
    if (!proc || proc.exited) {
      yield { type: 'error', message: 'Codex process exited unexpectedly' };
      yield { type: 'complete' };
      return;
    }
    if (proc.activeRun) {
      yield { type: 'error', message: 'Codex driver: a run is already active for this session' };
      yield { type: 'complete' };
      return;
    }

    const queue: HarnessEvent[] = [];
    let ended = false;
    let notify: (() => void) | null = null;
    proc.activeRun = {
      push: (event: HarnessEvent) => {
        queue.push(event);
        notify?.();
      },
      end: () => {
        ended = true;
        notify?.();
      },
    };

    this.send(proc, { type: 'message', text: message });

    try {
      for (;;) {
        while (queue.length > 0) {
          const event = queue.shift()!;
          yield event;
          if (event.type === 'complete') return;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
    } finally {
      proc.activeRun = undefined;
    }
  }

  async interrupt(session: HarnessSession): Promise<void> {
    const proc = this.processes.get(session.nativeSessionId);
    if (!proc || proc.exited) return;
    this.send(proc, { type: 'interrupt' });
  }

  async stop(session: HarnessSession): Promise<void> {
    const proc = this.processes.get(session.nativeSessionId);
    if (!proc || proc.exited) return;
    proc.shutdownRequested = true;
    this.send(proc, { type: 'shutdown' });

    if (!(await this.waitForExit(proc, this.config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS))) {
      debug('[codex-driver] shutdown not acknowledged — sending SIGTERM');
      proc.child.kill('SIGTERM');
    }
    if (!proc.exited && !(await this.waitForExit(proc, this.config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS))) {
      debug('[codex-driver] SIGTERM ignored — sending SIGKILL');
      proc.child.kill('SIGKILL');
      await this.waitForExit(proc, FINAL_KILL_TIMEOUT_MS);
    }
  }

  // ---------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------

  private async spawnAndInit(
    args: HarnessCreateArgs,
    nativeSessionId: string | undefined
  ): Promise<HarnessSession> {
    const proc = this.spawnProcess(args);
    this.pendingSpawns.add(proc);

    const init: Record<string, unknown> = {
      type: 'init',
      workingDirectory: args.workingDirectory ?? args.workspaceRootPath,
      ...(args.configMode !== undefined ? { configMode: args.configMode } : {}),
      ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
      ...(args.thinkingLevel !== undefined ? { thinkingLevel: args.thinkingLevel } : {}),
    };
    if (nativeSessionId !== undefined) {
      init.nativeSessionId = nativeSessionId;
    }
    this.send(proc, init);

    const timeoutMs = this.config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    proc.readyTimer = setTimeout(() => {
      if (proc.readySettled) return;
      proc.readySettled = true;
      proc.readyReject(new Error(`Codex did not become ready within ${timeoutMs}ms`));
      debug('[codex-driver] ready timeout — killing subprocess');
      proc.child.kill('SIGKILL');
    }, timeoutMs);

    try {
      await proc.readyPromise;
      const sessionId = proc.sessionId!;
      this.pendingSpawns.delete(proc);
      this.processes.set(sessionId, proc);
      return { nativeSessionId: sessionId, managed: true };
    } catch (error) {
      this.pendingSpawns.delete(proc);
      throw error;
    }
  }

  private spawnProcess(args: HarnessCreateArgs): CodexProcess {
    const command = this.config.command;
    const commandArgs = this.config.args;
    const child = spawn(command, commandArgs, {
      cwd: args.workingDirectory ?? args.workspaceRootPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.config.env,
      },
    });

    let readyResolve!: () => void;
    let readyReject!: (err: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const proc: CodexProcess = {
      child,
      readline: createInterface({ input: child.stdout!, crlfDelay: Infinity }),
      readyPromise,
      readyResolve,
      readyReject,
      readySettled: false,
      exited: false,
      shutdownRequested: false,
    };

    proc.readline.on('line', (line: string) => {
      this.handleLine(proc, line);
    });

    // Always capture stderr for debugging.
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      const trimmed = text.trim();
      if (trimmed) debug(`[codex-driver stderr] ${trimmed}`);
    });

    child.on('exit', (code, signal) => {
      debug(`[codex-driver] subprocess exited (code=${code}, signal=${signal})`);
      proc.exited = true;
      this.cleanupProcess(proc);
      if (!proc.readySettled) {
        proc.readySettled = true;
        clearTimeout(proc.readyTimer);
        proc.readyReject(new Error('Codex process exited before ready'));
        return;
      }
      const run = proc.activeRun;
      if (run) {
        if (!proc.shutdownRequested) {
          run.push({ type: 'error', message: 'Codex process exited unexpectedly' });
        }
        // Always close the turn stream cleanly (synthetic complete).
        run.push({ type: 'complete' });
        run.end();
      }
    });

    child.on('error', (error) => {
      const errno = error as NodeJS.ErrnoException;
      const message =
        errno.code === 'ENOENT'
          ? `Codex CLI not found. Install 'codex' or configure command path.`
          : `Codex subprocess error: ${error.message}`;
      debug(`[codex-driver] ${message}`);
      proc.exited = true;
      this.cleanupProcess(proc);
      if (!proc.readySettled) {
        proc.readySettled = true;
        clearTimeout(proc.readyTimer);
        proc.readyReject(new Error(message));
        return;
      }
      const run = proc.activeRun;
      if (run) {
        run.push({ type: 'error', message });
        run.push({ type: 'complete' });
        run.end();
      }
    });

    return proc;
  }

  private handleLine(proc: CodexProcess, line: string): void {
    const parsed = parseCodexEvent(line);
    if (!parsed) {
      debug(`[codex-driver] skipping unparseable line: ${line.slice(0, 200)}`);
      return;
    }
    if (parsed.type === 'ready') {
      proc.sessionId = parsed.sessionId;
      if (proc.readySettled) return;
      proc.readySettled = true;
      clearTimeout(proc.readyTimer);
      proc.readyResolve();
      return;
    }
    // HarnessEvent — only routed while a run is active. Unsolicited events
    // (outside a turn) are dropped by contract.
    proc.activeRun?.push(parsed);
  }

  private send(proc: CodexProcess, message: Record<string, unknown>): void {
    if (proc.exited || proc.child.stdin?.destroyed) return;
    proc.child.stdin!.write(JSON.stringify(message) + '\n');
  }

  private cleanupProcess(proc: CodexProcess): void {
    this.pendingSpawns.delete(proc);
    if (proc.sessionId !== undefined) {
      this.processes.delete(proc.sessionId);
    }
    proc.readline.close();
  }

  /** Resolve true when the process exits within timeoutMs; false on timeout. */
  private waitForExit(proc: CodexProcess, timeoutMs: number): Promise<boolean> {
    if (proc.exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      proc.child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
