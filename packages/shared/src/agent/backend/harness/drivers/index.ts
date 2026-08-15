/**
 * Built-in harness drivers (Issue #10).
 *
 * Drivers register themselves via registerHarnessDriver() from the harness
 * registry. SessionManager's getOrCreateAgent() looks up drivers by harness
 * type when dispatching external-harness agent sessions.
 */

import { CodexDriver } from './codex-driver.ts';
import { ClaudeSdkDriver } from './claude-sdk-driver.ts';
import { PiSdkDriver } from './pi-sdk-driver.ts';
import { registerHarnessDriver } from '../registry.ts';

export { CodexDriver, type CodexDriverConfig } from './codex-driver.ts';
export { ClaudeSdkDriver } from './claude-sdk-driver.ts';
export { PiSdkDriver } from './pi-sdk-driver.ts';

/**
 * Register all built-in harness drivers. Call once at server startup,
 * before any agent sessions are created.
 */
export function registerBuiltinHarnessDrivers(): void {
  registerHarnessDriver(new CodexDriver());
  // Claude runs over the official agent SDK with the user's local native
  // configuration (configMode 'local-inherit' by default — no Craft-supplied
  // systemPrompt/model, SDK uses local OAuth config).
  registerHarnessDriver(new ClaudeSdkDriver());
  // Pi runs over the in-process pi coding agent SDK, local-inherit only (P0).
  registerHarnessDriver(new PiSdkDriver());
}
