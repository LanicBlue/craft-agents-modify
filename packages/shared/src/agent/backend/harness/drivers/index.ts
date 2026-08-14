/**
 * Built-in harness drivers (Issue #10).
 *
 * Drivers register themselves via registerHarnessDriver() from the harness
 * registry. SessionManager's getOrCreateAgent() looks up drivers by harness
 * type when dispatching external-harness agent sessions.
 */

import { CodexDriver } from './codex-driver.ts';
import { registerHarnessDriver } from '../registry.ts';

export { CodexDriver, type CodexDriverConfig } from './codex-driver.ts';

/**
 * Register all built-in harness drivers. Call once at server startup,
 * before any agent sessions are created.
 */
export function registerBuiltinHarnessDrivers(): void {
  registerHarnessDriver(new CodexDriver());
}
