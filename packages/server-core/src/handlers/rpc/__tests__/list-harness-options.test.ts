/**
 * agents:listHarnessOptions handler contract (Issue #17 W7-2).
 *
 * - driver with listOptions → its options
 * - driver without listOptions (codex/kimi-style) → null (fail-soft)
 * - unregistered harness → null
 * - driver errors propagate (renderer catches and falls back) — verified
 *   with a throwing fake driver.
 *
 * Real WsRpcServer + WsRpcClient, real registerAgentsHandlers, fake drivers
 * registered into the module-level driver registry (per-file module instance
 * in bun — no cross-file pollution).
 */

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WsRpcServer } from '../../../transport/server'
import { WsRpcClient } from '../../../transport/client'
import { registerAgentsHandlers } from '../agents'
import { addWorkspace, ensureConfigDir, saveConfig } from '@craft-agent/shared/config'
import { registerHarnessDriver } from '@craft-agent/shared/agent/backend'
import type {
  HarnessDriver,
  HarnessSession,
  HarnessOptions,
} from '@craft-agent/shared/agent/backend'
import type { HandlerDeps } from '../../handler-deps'

const TOKEN = 'list-harness-options-token'

function fakeDriver(
  harness: 'pi' | 'kimi',
  opts?: { options?: HarnessOptions; throwOnList?: boolean },
): HarnessDriver {
  return {
    harness,
    async create(): Promise<HarnessSession> {
      return { nativeSessionId: 'fake', managed: true, harness } as HarnessSession
    },
    async resume(): Promise<HarnessSession> {
      return { nativeSessionId: 'fake', managed: true, harness } as HarnessSession
    },
    async *run(): AsyncIterable<never> {
      yield* []
    },
    async stop(): Promise<void> {},
    async listOptions(): Promise<HarnessOptions> {
      if (opts?.throwOnList) throw new Error('local auth missing')
      return opts?.options ?? { models: [] }
    },
  }
}

describe('agents:listHarnessOptions', () => {
  it('returns null for unregistered harnesses and drivers without listOptions', async () => {
    // kimi-style fake: no listOptions method
    const kimi = fakeDriver('kimi')
    delete (kimi as { listOptions?: unknown }).listOptions
    registerHarnessDriver(kimi)

    const server = new WsRpcServer({
      host: '127.0.0.1', port: 0, requireAuth: true,
      validateToken: async (t) => t === TOKEN, serverId: 'lho-test',
    })
    await server.listen()
    const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      token: TOKEN, workspaceId: 'lho-ws', clientCapabilities: [], autoReconnect: false,
    })
    client.connect()
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('client never connected')), 5000)
      const off = client.onConnectionStateChanged((state) => {
        if (state.status === 'connected') { clearTimeout(t); off(); resolve() }
        else if (state.status === 'failed' || state.status === 'disconnected') {
          clearTimeout(t); off(); reject(new Error(`status=${state.status}`))
        }
      })
    })
    registerAgentsHandlers(server, {} as HandlerDeps)
    try {
      const invoke = (channel: string, ...args: unknown[]) => client.invoke(channel, ...args)
      // Unregistered harness → null (fail-soft).
      expect(await invoke('agents:listHarnessOptions' as never, 'nonexistent-harness' as never)).toBeNull()
      // Registered driver without listOptions → null (fail-soft).
      expect(await invoke('agents:listHarnessOptions' as never, 'kimi' as never)).toBeNull()
    } finally {
      client.destroy()
      await server.close()
    }
  })

  it('returns driver options and propagates driver errors', async () => {
    const pi = fakeDriver('pi', {
      options: { models: [{ id: 'm1', name: 'Model One', thinkingLevels: ['off', 'high'] }], permissionModes: ['safe', 'ask'] },
    })
    registerHarnessDriver(pi)

    const server = new WsRpcServer({
      host: '127.0.0.1', port: 0, requireAuth: true,
      validateToken: async (t) => t === TOKEN, serverId: 'lho-test-2',
    })
    await server.listen()
    const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      token: TOKEN, workspaceId: 'lho-ws-2', clientCapabilities: [], autoReconnect: false,
    })
    client.connect()
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('client never connected')), 5000)
      const off = client.onConnectionStateChanged((state) => {
        if (state.status === 'connected') { clearTimeout(t); off(); resolve() }
        else if (state.status === 'failed' || state.status === 'disconnected') {
          clearTimeout(t); off(); reject(new Error(`status=${state.status}`))
        }
      })
    })
    registerAgentsHandlers(server, {} as HandlerDeps)
    try {
      const invoke = (channel: string, ...args: unknown[]) => client.invoke(channel, ...args)
      const options = await invoke('agents:listHarnessOptions' as never, 'pi' as never) as HarnessOptions
      expect(options.models).toEqual([{ id: 'm1', name: 'Model One', thinkingLevels: ['off', 'high'] }])
      expect(options.permissionModes).toEqual(['safe', 'ask'])
      // Harness without local auth → error propagates as-is (never swallowed).
      const throwing = fakeDriver('pi', { throwOnList: true })
      registerHarnessDriver(throwing) // replace the healthy fake
      let caught: { message?: string; code?: unknown } | null = null
      try {
        await invoke('agents:listHarnessOptions' as never, 'pi' as never)
      } catch (err) {
        caught = err as { message?: string; code?: unknown }
      }
      expect(caught?.message).toContain('local auth missing')
    } finally {
      client.destroy()
      await server.close()
    }
  })
})
