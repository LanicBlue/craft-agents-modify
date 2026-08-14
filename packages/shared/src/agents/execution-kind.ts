/**
 * Execution Kind Guard (Issue #8)
 *
 * Creates the execution seam described in ADR #14 Decision 8.
 * Recognizes external-harness execution kind and rejects it with a
 * clear error until the ExternalHarnessBackend (Issue #9) and harness
 * drivers (Issue #10) are implemented.
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
      `External harness execution ('${harness}') is not yet implemented. ` +
        `See Issue #9 (ExternalHarnessBackend) and #10 (harness drivers).`
    )
  }
}
