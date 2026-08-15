/**
 * Execution Kind Guard (Issue #8)
 *
 * Creates the execution seam described in ADR #14 Decision 8.
 * Rejects external-harness execution on paths that predate harness dispatch
 * (defensive guard — the runtime dispatch path handles codex/claude via
 * ExternalHarnessBackend, Issue #17; kimi drivers are pending).
 *
 * For craft-backend or non-agent sessions: no-op (existing flows unchanged).
 */

import { loadLatestRevision } from './storage.ts'

/**
 * Assert that the execution kind for the given agent is supported by
 * the current backend factory. Throws a descriptive error for
 * unimplemented execution kinds (external-harness).
 *
 * No-ops when:
 * - agentId is undefined (non-agent session)
 * - agent has no revision
 * - execution kind is 'craft-backend'
 */
export function assertSupportedExecutionKind(agentId?: string): void {
  if (!agentId) return
  const revision = loadLatestRevision(agentId)
  if (!revision) return
  if (revision.execution.kind === 'external-harness') {
    const harness = revision.execution.harness
    throw new Error(
      `External harness execution ('${harness}') is not supported on this path. ` +
        `Harness drivers: codex/claude implemented (Issue #17); kimi pending.`
    )
  }
}
