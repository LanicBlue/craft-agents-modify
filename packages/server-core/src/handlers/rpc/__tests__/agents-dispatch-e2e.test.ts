/**
 * E2E (real machine, env-gated): full RPC dispatch loop through the REAL
 * claude SDK harness — the exact path Project Service would take.
 *
 *   WsRpcClient → agentSessions:dispatch → admission → ensureAgentSession
 *   → adoptPersistedSession → SessionManager.sendMessage → getOrCreateAgent
 *   (harness branch) → ClaudeSdkDriver → real SDK (local user OAuth)
 *   → session_bound persisted → disk persistence → restart → same session.
 *
 * Gated by CRAFT_CLAUDE_SDK_E2E=1 (uses the local Claude login + network).
 * Everything real: real transport, real handlers, real SessionManager, real
 * registry/bindings, real SDK. No mocks anywhere.
 */

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const E2E = process.env.CRAFT_CLAUDE_SDK_E2E === '1'

describe.skipIf(!E2E)('agentSessions:dispatch end-to-end over real RPC + real SDK', () => {
  it('dispatch → reuse → restart resume, one canonical native session', async () => {
    const { WsRpcServer } = await import('../../../transport/server')
    const { WsRpcClient } = await import('../../../transport/client')
    const { registerAgentsHandlers } = await import('../agents')
    const { registerBuiltinHarnessDrivers } = await import('@craft-agent/shared/agent/backend/harness/drivers')
    const { addWorkspace, ensureConfigDir, saveConfig } = await import('@craft-agent/shared/config')
    const { SessionManager } = await import('../../../sessions/SessionManager')
    const { loadSession, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
    const { getBinding } = await import('@craft-agent/shared/agents')

    const TOKEN = 'e2e-dispatch-token-with-enough-entropy'
    ensureConfigDir()
    saveConfig({ workspaces: [], activeWorkspaceId: null, activeSessionId: null })
    const wsRoot = mkdtempSync(join(tmpdir(), 'e2e-rpc-ws-'))
    const workspace = addWorkspace({ name: 'E2E RPC WS', rootPath: wsRoot })

    registerBuiltinHarnessDrivers() // codex + claude (idempotent)

    async function withRpc<T>(
      sessionManager: unknown,
      fn: (invoke: (channel: string, ...args: unknown[]) => Promise<T>) => Promise<void>,
    ): Promise<void> {
      const server = new WsRpcServer({
        host: '127.0.0.1', port: 0, requireAuth: true,
        validateToken: async (t) => t === TOKEN, serverId: 'e2e',
      })
      await server.listen()
      const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
        token: TOKEN, workspaceId: workspace.id, clientCapabilities: [], autoReconnect: false,
      })
      client.connect()
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('client never connected')), 5000)
        const off = client.onConnectionStateChanged((state) => {
          if (state.status === 'connected') { clearTimeout(timer); off(); resolve() }
          else if (state.status === 'failed' || state.status === 'disconnected') {
            clearTimeout(timer); off(); reject(new Error(`status=${state.status}`))
          }
        })
      })
      registerAgentsHandlers(server, { sessionManager } as never)
      try {
        await fn((channel, ...args) => client.invoke(channel, ...args) as Promise<T>)
      } finally {
        client.destroy()
        await server.close()
      }
    }

    try {
      // --- Incarnation 1: create + first dispatch + reuse ---
      const sm1 = new SessionManager()
      const marker = `E2E-PONG-${Date.now().toString(36)}`
      let sessionId = ''
      let sdkSessionId = ''

      await withRpc(sm1, async (invoke) => {
        const agent = await invoke('agents:create' as never, {
          id: 'e2e-rpc-agent',
          name: 'E2E RPC Agent',
          execution: { kind: 'external-harness', harness: 'claude', configMode: 'local-inherit' },
          systemPrompt: 'You are the e2e echo agent.',
        } as never)
        expect((agent as { id?: string }).id).toBe('e2e-rpc-agent')

        const r1 = await invoke('agentSessions:dispatch' as never, 'E2E RPC WS', 'e2e-rpc-agent',
          `Reply with exactly: ${marker}`) as { sessionId: string; accepted: boolean; bindingGeneration: number }
        expect(r1.accepted).toBe(true)
        expect(r1.bindingGeneration).toBe(1)
        sessionId = r1.sessionId
        expect(sessionId.length).toBeGreaterThan(0)

        await sessionPersistenceQueue.flush(sessionId)
        const stored = loadSession(wsRoot, sessionId)
        expect(stored).not.toBeNull()
        sdkSessionId = stored!.sdkSessionId ?? ''
        expect(sdkSessionId.length).toBeGreaterThan(0) // session_bound persisted
        const texts = stored!.messages.map((m) => ({ type: m.type, content: m.content ?? '' }))
        expect(texts.some((m) => m.type === 'user' && m.content.includes(marker))).toBe(true)
        expect(texts.some((m) => m.type === 'assistant' && m.content.includes(marker))).toBe(true)

        const rt = await invoke('agentSessions:getRuntime' as never, 'E2E RPC WS', 'e2e-rpc-agent') as {
          state?: string; generation?: number
        }
        expect(rt.state).toBe('bound')
        expect(rt.generation).toBe(1)

        // Second dispatch on the same incarnation: same canonical session.
        const r2 = await invoke('agentSessions:dispatch' as never, 'E2E RPC WS', 'e2e-rpc-agent',
          'Reply with exactly: E2E-SECOND') as { sessionId: string; bindingGeneration: number }
        expect(r2.sessionId).toBe(sessionId)
        expect(r2.bindingGeneration).toBe(1)
        await sessionPersistenceQueue.flush(sessionId)
        expect(loadSession(wsRoot, sessionId)!.sdkSessionId).toBe(sdkSessionId)
      })

      // Binding state on disk: bound, generation 1, canonical session matches.
      const binding = getBinding(wsRoot, 'e2e-rpc-agent')
      expect(binding?.state).toBe('bound')
      expect(binding?.generation).toBe(1)
      expect(binding?.canonicalSessionId).toBe(sessionId)

      // --- Incarnation 2 (restart): fresh SessionManager, same native session ---
      const sm2 = new SessionManager()
      await withRpc(sm2, async (invoke) => {
        const r3 = await invoke('agentSessions:dispatch' as never, 'E2E RPC WS', 'e2e-rpc-agent',
          'Reply with exactly: E2E-RESTART') as { sessionId: string; bindingGeneration: number }
        expect(r3.sessionId).toBe(sessionId)      // same canonical session
        expect(r3.bindingGeneration).toBe(1)      // binding not rotated
        await sessionPersistenceQueue.flush(sessionId)
        const stored = loadSession(wsRoot, sessionId)
        expect(stored!.sdkSessionId).toBe(sdkSessionId) // resumed the SAME native session — no fork
        const texts = stored!.messages.map((m) => ({ type: m.type, content: m.content ?? '' }))
        expect(texts.some((m) => m.type === 'assistant' && m.content.includes('E2E-RESTART'))).toBe(true)
        expect(texts.some((m) => m.type === 'assistant' && m.content.includes(marker))).toBe(true) // history intact
      })

      // Session file exists under the .craft-agent namespace (#16).
      expect(existsSync(join(wsRoot, '.craft-agent', 'sessions', sessionId, 'session.jsonl'))).toBe(true)
      // Sanity: the jsonl is well-formed header + messages.
      const firstLine = JSON.parse(readFileSync(
        join(wsRoot, '.craft-agent', 'sessions', sessionId, 'session.jsonl'), 'utf-8').split('\n')[0]!)
      expect(firstLine.agentId).toBe('e2e-rpc-agent')
    } finally {
      rmSync(wsRoot, { recursive: true, force: true })
    }
  }, 300_000)
})
