/**
 * E2E: agent binding error codes reach the RPC client as structured `.code`
 * (Wave 1 R4 — replaces the old JSON-in-message serialization).
 *
 * `CONFIG_DIR` is captured at module-load from `process.env.CRAFT_CONFIG_DIR`,
 * so the scenario runs in a SUBPROCESS (same pattern as
 * config/__tests__/preferences-ui-language.test.ts): the runner branch
 * (AGENTS_ERROR_CODES_RUNNER=1) spins up a real WsRpcServer + WsRpcClient,
 * registers the REAL agents RPC handlers against an isolated config dir,
 * invokes, and prints the observed error shape; the parent branch asserts.
 */

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { HandlerDeps } from '../../handler-deps'

const RUNNER_MODE = process.env.AGENTS_ERROR_CODES_RUNNER === '1'

if (RUNNER_MODE) {
  // -------------------------------------------------------------------------
  // Runner branch — executes in the isolated subprocess (CRAFT_CONFIG_DIR set)
  // -------------------------------------------------------------------------
  const { WsRpcServer } = await import('../../../transport/server')
  const { WsRpcClient } = await import('../../../transport/client')
  const { CodedError } = await import('@craft-agent/shared/protocol')
  const { registerAgentsHandlers } = await import('../agents')
  const { addWorkspace, ensureConfigDir, saveConfig } = await import('@craft-agent/shared/config')
  const { createAgent, retireAgent, updateAgent } = await import('@craft-agent/shared/agents')

  const TEST_TOKEN = 'test-token-with-enough-entropy-to-pass'
  // Seed an empty config (config.json is created by saveConfig; addWorkspace
  // requires it to already exist).
  ensureConfigDir()
  saveConfig({ workspaces: [], activeWorkspaceId: null, activeSessionId: null })
  const wsRoot = mkdtempSync(join(tmpdir(), 'agents-rpc-code-ws-'))
  const workspace = addWorkspace({ name: 'Agents RPC Code WS', rootPath: wsRoot })

  const server = new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    requireAuth: true,
    validateToken: async (t) => t === TEST_TOKEN,
    serverId: 'test',
  })
  await server.listen()

  const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
    token: TEST_TOKEN,
    workspaceId: workspace.id,
    clientCapabilities: [],
    autoReconnect: false,
  })
  client.connect()
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('client never connected')), 2000)
    const off = client.onConnectionStateChanged((state) => {
      if (state.status === 'connected') {
        clearTimeout(t)
        off()
        resolve()
      } else if (state.status === 'failed' || state.status === 'disconnected') {
        clearTimeout(t)
        off()
        reject(new Error(`status=${state.status}`))
      }
    })
  })

  registerAgentsHandlers(server, {
    sessionManager: undefined,
  } as unknown as HandlerDeps)

  const result: Record<string, unknown> = {}
  try {
    try {
      await client.invoke('agentSessions:ensure', 'Agents RPC Code WS', 'no-such-agent')
      result.notFoundCode = null
    } catch (err) {
      const e = err as { code?: string; message?: string }
      result.notFoundCode = e.code ?? null
      result.notFoundMessage = e.message ?? ''
      result.isCodedInstance = err instanceof CodedError
    }

    const agent = createAgent({
      id: 'rpc-code-retire-agent',
      name: 'RPC Code Retire Agent',
      execution: { kind: 'craft-backend', llmConnection: 'anthropic', model: 'claude-opus-4-8' },
      systemPrompt: 'You are the retire agent.',
    })
    retireAgent(agent.id)
    try {
      await client.invoke('agentSessions:ensure', 'Agents RPC Code WS', agent.id)
      result.retiredCode = null
    } catch (err) {
      result.retiredCode = (err as { code?: string }).code ?? null
    }

    // Invalid id via RPC CREATE surfaces as AGENT_ID_INVALID (Issue #2).
    try {
      await client.invoke('agents:create', {
        id: 'Invalid_Id',
        name: 'Bad Id Agent',
        execution: { kind: 'craft-backend' },
        systemPrompt: 'You are a bad id agent.',
      })
      result.invalidIdCode = null
    } catch (err) {
      result.invalidIdCode = (err as { code?: string }).code ?? null
      result.invalidIdMessage = (err as { message?: string }).message ?? ''
    }

    // CAS conflict over the wire: stale expectedRecordVersion → AGENT_VERSION_CONFLICT.
    const casAgent = createAgent({
      id: 'rpc-cas-agent',
      name: 'RPC CAS Agent',
      execution: { kind: 'craft-backend', llmConnection: 'anthropic', model: 'claude-opus-4-8' },
      systemPrompt: 'You are the cas agent.',
    })
    updateAgent(casAgent.id, { name: 'CAS v2' }) // recordVersion 1 → 2
    try {
      await client.invoke('agents:update', 'rpc-cas-agent', { name: 'stale' }, 1)
      result.casConflictCode = null
    } catch (err) {
      result.casConflictCode = (err as { code?: string }).code ?? null
    }
    // The current version still succeeds.
    try {
      const ok = await client.invoke('agents:update', 'rpc-cas-agent', { name: 'fresh' }, 2)
      result.casFreshOk = (ok as { recordVersion?: number }).recordVersion ?? null
    } catch {
      result.casFreshOk = 'error'
    }
  } finally {
    client.destroy()
    await server.close()
    rmSync(wsRoot, { recursive: true, force: true })
  }

  console.log(JSON.stringify(result))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Parent branch — asserts on the subprocess observation
// ---------------------------------------------------------------------------

describe('agent error codes over RPC (real handlers, real transport)', () => {
  it('AGENT_NOT_FOUND / AGENT_RETIRED surface as err.code, not JSON blobs', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'agents-rpc-code-config-'))
    try {
      const spawned = Bun.spawnSync([process.execPath, import.meta.path], {
        env: {
          ...process.env,
          CRAFT_CONFIG_DIR: configDir,
          AGENTS_ERROR_CODES_RUNNER: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(spawned.exitCode).toBe(0)
      const out = JSON.parse(spawned.stdout.toString()) as Record<string, unknown>
      expect(out.notFoundCode).toBe('AGENT_NOT_FOUND')
      expect(out.retiredCode).toBe('AGENT_RETIRED')
      // Invalid id through the CREATE channel keeps its structured code.
      expect(out.invalidIdCode).toBe('AGENT_ID_INVALID')
      expect(String(out.invalidIdMessage)).toContain('Invalid agent id')
      // CAS conflict keeps its structured code over the wire.
      expect(out.casConflictCode).toBe('AGENT_VERSION_CONFLICT')
      expect(out.casFreshOk).toBe(3)
      // Message stays human-readable — never a JSON blob.
      expect(String(out.notFoundMessage)).toContain('Agent not found')
      expect(String(out.notFoundMessage)).not.toContain('{')
      // Class identity is lost over the wire — callers branch on `.code`.
      expect(out.isCodedInstance).toBe(false)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
