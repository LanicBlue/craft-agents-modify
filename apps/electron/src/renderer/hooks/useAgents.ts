/**
 * useAgents Hook
 *
 * React hook to load and manage AgentProfiles (global registry) via IPC.
 * Auto-refreshes on mount; mutations (create/update/retire/restore) refresh
 * the list afterwards. No CHANGED push channel exists for agents yet, so the
 * list only updates on explicit refresh or mutation.
 */

import { useState, useEffect, useCallback } from 'react'
import type { AgentRecord, AgentProfileRevision, CreateAgentInput, UpdateAgentInput } from '@craft-agent/shared/agents'

export interface UseAgentsResult {
  /** Agent records (retired excluded unless includeRetired is set) */
  agents: AgentRecord[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
  create: (input: CreateAgentInput) => Promise<AgentRecord>
  update: (agentId: string, input: UpdateAgentInput) => Promise<AgentRecord>
  retire: (agentId: string) => Promise<void>
  restore: (agentId: string) => Promise<void>
  getLatestRevision: (agentId: string) => Promise<AgentProfileRevision>
}

/**
 * Load AgentProfiles via IPC.
 * `includeRetired` controls whether retired agents appear in the list;
 * changes to it re-trigger loading.
 */
export function useAgents(options?: { includeRetired?: boolean }): UseAgentsResult {
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true)
      const result = await window.electronAPI.listAgents(options?.includeRetired)
      setAgents(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agents')
    } finally {
      setIsLoading(false)
    }
  }, [options?.includeRetired])

  useEffect(() => {
    refresh()
  }, [refresh])

  const create = useCallback(async (input: CreateAgentInput) => {
    const agent = await window.electronAPI.createAgent(input)
    await refresh()
    return agent
  }, [refresh])

  const update = useCallback(async (agentId: string, input: UpdateAgentInput) => {
    const agent = await window.electronAPI.updateAgent(agentId, input)
    await refresh()
    return agent
  }, [refresh])

  const retire = useCallback(async (agentId: string) => {
    await window.electronAPI.retireAgent(agentId)
    await refresh()
  }, [refresh])

  const restore = useCallback(async (agentId: string) => {
    await window.electronAPI.restoreAgent(agentId)
    await refresh()
  }, [refresh])

  const getLatestRevision = useCallback((agentId: string) => {
    return window.electronAPI.getLatestAgentRevision(agentId)
  }, [])

  return { agents, isLoading, error, refresh, create, update, retire, restore, getLatestRevision }
}
