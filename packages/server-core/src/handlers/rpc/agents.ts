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
  type CreateAgentInput,
  type UpdateAgentInput,
} from '@craft-agent/shared/agents'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

/**
 * Convert AgentSessionBindingError into a structured RPC error:
 * the 5 binding error codes must reach RPC callers unchanged.
 */
function bindingErrorToRpc(e: unknown): Error {
  if (e instanceof AgentSessionBindingError) {
    return new Error(JSON.stringify({ code: e.code, message: e.message }))
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
    const agent = getAgent(agentId)
    if (!agent) throw new Error(`Agent not found: ${agentId}`)
    return agent
  })

  server.handle(RPC_CHANNELS.agents.CREATE, async (_ctx, input: CreateAgentInput) => {
    return createAgent(input)
  })

  server.handle(RPC_CHANNELS.agents.UPDATE, async (_ctx, agentId: string, input: UpdateAgentInput) => {
    return updateAgent(agentId, input)
  })

  server.handle(RPC_CHANNELS.agents.RETIRE, async (_ctx, agentId: string) => {
    return retireAgent(agentId)
  })

  server.handle(RPC_CHANNELS.agents.RESTORE, async (_ctx, agentId: string) => {
    return restoreAgent(agentId)
  })

  server.handle(RPC_CHANNELS.agents.GET_LATEST_REVISION, async (_ctx, agentId: string) => {
    const revision = loadLatestRevision(agentId)
    if (!revision) throw new Error(`No revision found for agent: ${agentId}`)
    return revision
  })

  // ------------------------------------------------------------------
  // agentSessions — execution control (workspace-scoped)
  // ------------------------------------------------------------------

  server.handle(RPC_CHANNELS.agentSessions.LIST, async (_ctx, workspaceId: string) => {
    const ws = getWorkspaceByNameOrId(workspaceId)
    if (!ws) throw new Error('Workspace not found')
    return listBindings(ws.rootPath)
  })

  server.handle(RPC_CHANNELS.agentSessions.ENSURE, async (_ctx, workspaceId: string, agentId: string) => {
    const ws = getWorkspaceByNameOrId(workspaceId)
    if (!ws) throw new Error('Workspace not found')
    try {
      const session = await ensureAgentSession(ws.rootPath, ws.id, agentId)
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
