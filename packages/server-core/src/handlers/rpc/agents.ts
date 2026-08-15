/**
 * Agent Profile + Agent Session Execution RPC handlers (Issue #5).
 *
 * agents.*       — global AgentProfile registry CRUD (workspace-agnostic)
 * agentSessions.*— execution control for agent sessions, addressed by
 *                  workspaceId + agentId (PS never uses raw sessionId as a
 *                  primary key; sessionId is returned for diagnostics only).
 *
 * Errors: AgentSessionBindingError codes are preserved for RPC callers by
 * serializing { code, message } into the thrown Error message.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  retireAgent,
  restoreAgent,
  loadLatestRevision,
  listBindings,
  ensureAgentSession,
  resolveBinding,
  AgentSessionBindingError,
  AgentRegistryError,
  type AgentBindingDiagnostics,
  type CreateAgentInput,
  type UpdateAgentInput,
} from '@craft-agent/shared/agents'
import { loadSession } from '@craft-agent/shared/sessions'
import type { RpcServer } from '@craft-agent/server-core/transport'
import { CodedError } from '@craft-agent/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import {
  getHarnessDriver,
  type HarnessType,
  type HarnessOptions,
} from '@craft-agent/shared/agent/backend'

/**
 * Convert AgentSessionBindingError / AgentRegistryError into structured RPC
 * errors: error codes reach RPC callers as `err.code` (transport preserves
 * ErrorCode through the wire), message stays human-readable.
 */
function bindingErrorToRpc(e: unknown): Error {
  if (e instanceof AgentSessionBindingError || e instanceof AgentRegistryError) {
    return new CodedError(e.code, e.message)
  }
  return e instanceof Error ? e : new Error(String(e))
}

export function registerAgentsHandlers(server: RpcServer, deps: HandlerDeps): void {
  // ------------------------------------------------------------------
  // agents — AgentProfile registry (global)
  // ------------------------------------------------------------------

  server.handle(RPC_CHANNELS.agents.LIST, async (_ctx, includeRetired?: boolean) => {
    return listAgents({ includeRetired })
  })

  server.handle(RPC_CHANNELS.agents.GET, async (_ctx, agentId: string) => {
    try {
      const agent = getAgent(agentId)
      if (!agent) throw new AgentRegistryError('AGENT_NOT_FOUND', `Agent not found: ${agentId}`)
      return agent
    } catch (e) {
      throw bindingErrorToRpc(e)
    }
  })

  server.handle(RPC_CHANNELS.agents.CREATE, async (_ctx, input: CreateAgentInput) => {
    try {
      return createAgent(input)
    } catch (e) {
      throw bindingErrorToRpc(e)
    }
  })

  server.handle(RPC_CHANNELS.agents.UPDATE, async (_ctx, agentId: string, input: UpdateAgentInput, expectedRecordVersion?: number) => {
    try {
      return updateAgent(agentId, input, expectedRecordVersion)
    } catch (e) {
      throw bindingErrorToRpc(e)
    }
  })

  server.handle(RPC_CHANNELS.agents.RETIRE, async (_ctx, agentId: string, expectedRecordVersion?: number) => {
    try {
      return retireAgent(agentId, expectedRecordVersion)
    } catch (e) {
      throw bindingErrorToRpc(e)
    }
  })

  server.handle(RPC_CHANNELS.agents.RESTORE, async (_ctx, agentId: string, expectedRecordVersion?: number) => {
    try {
      return restoreAgent(agentId, expectedRecordVersion)
    } catch (e) {
      throw bindingErrorToRpc(e)
    }
  })

  server.handle(RPC_CHANNELS.agents.GET_LATEST_REVISION, async (_ctx, agentId: string) => {
    try {
      const revision = loadLatestRevision(agentId)
      if (!revision) throw new AgentRegistryError('AGENT_NOT_FOUND', `No revision found for agent: ${agentId}`)
      return revision
    } catch (e) {
      throw bindingErrorToRpc(e)
    }
  })

  // Option ranges for a harness' configuration surface (Issue #17 W7):
  // drivers that can't report options (codex/kimi) or are unregistered yield
  // null (fail-soft — the renderer falls back to hardcoded lists). Driver
  // errors (e.g. missing local auth) propagate as-is for the renderer to
  // catch and fall back — never swallowed or rewritten.
  server.handle(RPC_CHANNELS.agents.LIST_HARNESS_OPTIONS, async (_ctx, harness: string) => {
    const driver = getHarnessDriver(harness as HarnessType)
    if (!driver?.listOptions) return null
    return driver.listOptions()
  })

  // ------------------------------------------------------------------
  // agentSessions — execution control (workspace-scoped)
  // ------------------------------------------------------------------

  server.handle(RPC_CHANNELS.agentSessions.LIST, async (_ctx, workspaceId: string) => {
    const ws = getWorkspaceByNameOrId(workspaceId)
    if (!ws) throw new Error('Workspace not found')
    // Diagnostics enrichment (Issue #15): attach the canonical session's
    // profile revision when readable; unreadable/missing sessions stay
    // without the field (super-set of the previous shape — PS consumers
    // are unaffected).
    return listBindings(ws.rootPath).map((binding): AgentBindingDiagnostics => {
      if (binding.state === 'bound' && binding.canonicalSessionId) {
        const session = loadSession(ws.rootPath, binding.canonicalSessionId)
        if (session?.agentProfileRevision !== undefined) {
          return { ...binding, sessionProfileRevision: session.agentProfileRevision }
        }
      }
      return binding
    })
  })

  server.handle(RPC_CHANNELS.agentSessions.ENSURE, async (_ctx, workspaceId: string, agentId: string) => {
    const ws = getWorkspaceByNameOrId(workspaceId)
    if (!ws) throw new Error('Workspace not found')
    try {
      const session = await ensureAgentSession(ws.rootPath, ws.id, agentId)
      // Adopt the on-disk session into the SessionManager so the first
      // dispatch works without a restart (audit gap: SM only sees sessions
      // loaded at startup / reloadSessions).
      deps.sessionManager.adoptPersistedSession(ws, session.id)
      // sessionId / bindingGeneration are diagnostic/observability metadata,
      // not a workflow reference — Project Service addresses by (workspaceId, agentId).
      const bindingGeneration = resolveBinding(ws.rootPath, agentId)?.generation
      return { sessionId: session.id, agentId, workspaceId, bindingGeneration }
    } catch (e) {
      throw bindingErrorToRpc(e)
    }
  })

  server.handle(
    RPC_CHANNELS.agentSessions.DISPATCH,
    async (_ctx, workspaceId: string, agentId: string, message: string) => {
      const ws = getWorkspaceByNameOrId(workspaceId)
      if (!ws) throw new Error('Workspace not found')
      try {
        // ensureAgentSession auto-creates on first dispatch and reuses the
        // existing session afterwards — session replacement is transparent.
        const session = await ensureAgentSession(ws.rootPath, ws.id, agentId)
        // Adopt before sendMessage — the first dispatch must succeed without
        // any pre-registration (audit gap: sendMessage throws for unknown ids).
        const adopted = deps.sessionManager.adoptPersistedSession(ws, session.id)
        if (!adopted) {
          // The session was just ensured but is already gone from disk —
          // surfaced as an explicit availability failure, never a retry loop.
          throw bindingErrorToRpc(
            new AgentSessionBindingError(
              'AGENT_SESSION_UNAVAILABLE',
              `Canonical session ${session.id} for agent ${agentId} vanished from disk; manual resolution required`
            )
          )
        }
        await deps.sessionManager.sendMessage(session.id, message)
        const bindingGeneration = resolveBinding(ws.rootPath, agentId)?.generation
        return { sessionId: session.id, accepted: true, bindingGeneration }
      } catch (e) {
        throw bindingErrorToRpc(e)
      }
    }
  )

  server.handle(RPC_CHANNELS.agentSessions.INTERRUPT, async (_ctx, workspaceId: string, agentId: string) => {
    const ws = getWorkspaceByNameOrId(workspaceId)
    if (!ws) throw new Error('Workspace not found')
    const binding = resolveBinding(ws.rootPath, agentId)
    if (binding?.canonicalSessionId) {
      return deps.sessionManager.cancelProcessing(binding.canonicalSessionId)
    }
    return undefined
  })

  server.handle(RPC_CHANNELS.agentSessions.GET_RUNTIME, async (_ctx, workspaceId: string, agentId: string) => {
    const ws = getWorkspaceByNameOrId(workspaceId)
    if (!ws) throw new Error('Workspace not found')
    const binding = resolveBinding(ws.rootPath, agentId)
    return {
      state: binding?.state,
      canonicalSessionId: binding?.canonicalSessionId,
      generation: binding?.generation,
    }
  })
}
