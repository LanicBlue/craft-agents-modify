import { describe, test, expect } from 'bun:test'
import { getAllChannelValues, RPC_CHANNELS } from '../channels'
import { LOCAL_ONLY_CHANNELS, REMOTE_ELIGIBLE_CHANNELS } from '../routing'

/**
 * Issue #5 wire-format contract for agents.* and agentSessions.* channels.
 * These channel strings are the stable API consumed by Project Service — any
 * rename here is a breaking change.
 */
const EXPECTED_WIRE_STRINGS = {
  'agents:list': 'agents:list',
  'agents:get': 'agents:get',
  'agents:create': 'agents:create',
  'agents:update': 'agents:update',
  'agents:retire': 'agents:retire',
  'agents:restore': 'agents:restore',
  'agents:getLatestRevision': 'agents:getLatestRevision',
  'agentSessions:list': 'agentSessions:list',
  'agentSessions:ensure': 'agentSessions:ensure',
  'agentSessions:dispatch': 'agentSessions:dispatch',
  'agentSessions:interrupt': 'agentSessions:interrupt',
  'agentSessions:getRuntime': 'agentSessions:getRuntime',
} as const

const agentChannelValues = [...Object.values(RPC_CHANNELS.agents), ...Object.values(RPC_CHANNELS.agentSessions)]

describe('Issue #5 agent channels', () => {
  test('all 12 new channels exist in getAllChannelValues()', () => {
    const all = getAllChannelValues()
    for (const wire of Object.values(EXPECTED_WIRE_STRINGS)) {
      expect(all).toContain(wire)
    }
  })

  test('channel wire strings match the Issue #5/#15 spec', () => {
    expect(agentChannelValues).toHaveLength(12)
    const wireSet = new Set(agentChannelValues)
    // Every spec'd wire string must appear exactly once across the two namespaces
    expect(wireSet.size).toBe(12)
    for (const wire of Object.values(EXPECTED_WIRE_STRINGS)) {
      expect(wireSet.has(wire)).toBe(true)
    }
  })

  test('all new channels are REMOTE_ELIGIBLE', () => {
    for (const wire of Object.values(EXPECTED_WIRE_STRINGS)) {
      expect(REMOTE_ELIGIBLE_CHANNELS.has(wire)).toBe(true)
    }
  })

  test('no new channel is in LOCAL_ONLY_CHANNELS', () => {
    for (const wire of Object.values(EXPECTED_WIRE_STRINGS)) {
      expect(LOCAL_ONLY_CHANNELS.has(wire)).toBe(false)
    }
  })

  test('the exhaustive routing test contract still holds for the new channels', () => {
    // Mirrors routing.test.ts: every channel must be in exactly one set
    for (const wire of Object.values(EXPECTED_WIRE_STRINGS)) {
      const inLocal = LOCAL_ONLY_CHANNELS.has(wire)
      const inRemote = REMOTE_ELIGIBLE_CHANNELS.has(wire)
      expect((inLocal ? 1 : 0) + (inRemote ? 1 : 0)).toBe(1)
    }
  })
})
