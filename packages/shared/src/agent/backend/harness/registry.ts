/**
 * Harness Driver Registry (Issue #9)
 *
 * Maps HarnessType → HarnessDriver. Drivers register themselves at module
 * load (Issue #10 will register the Codex driver). SessionManager consults
 * this registry when dispatching external-harness sessions.
 */

import type { HarnessDriver, HarnessType } from './types.ts';

const DRIVER_REGISTRY = new Map<HarnessType, HarnessDriver>();

export function registerHarnessDriver(driver: HarnessDriver): void {
  DRIVER_REGISTRY.set(driver.harness, driver);
}

export function getHarnessDriver(harness: HarnessType): HarnessDriver | undefined {
  return DRIVER_REGISTRY.get(harness);
}

export function getRegisteredHarnessTypes(): HarnessType[] {
  return Array.from(DRIVER_REGISTRY.keys());
}
