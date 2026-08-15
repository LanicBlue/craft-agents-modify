/**
 * listOptions env-gated smoke tests (Issue #17 W7-1).
 *
 * Gated by the same env vars as the real-machine e2e suites:
 * - CRAFT_PI_SDK_E2E=1 → PiSdkDriver.listOptions against the local ~/.pi
 * - CRAFT_CLAUDE_SDK_E2E=1 → ClaudeSdkDriver.listOptions against the local
 *   Claude config (streaming input mode + supportedModels)
 *
 * These are not mocked: the whole point is proving the option ranges come
 * from the harness's REAL local configuration, not Craft-hardcoded values.
 */

import { describe, it, expect } from 'bun:test';

const PI_E2E = process.env.CRAFT_PI_SDK_E2E === '1';
const CLAUDE_E2E = process.env.CRAFT_CLAUDE_SDK_E2E === '1';

describe.skipIf(!PI_E2E)('PiSdkDriver.listOptions (real local pi)', () => {
  it('returns models from the local auth-filtered registry', async () => {
    const { PiSdkDriver } = await import(
      '../pi-sdk-driver.ts'
    );
    const options = await new PiSdkDriver().listOptions();

    expect(options.models.length).toBeGreaterThan(0);
    expect(options.models[0]!.id.length).toBeGreaterThan(0);
    expect(Array.isArray(options.models[0]!.thinkingLevels)).toBe(true);
    expect(options.permissionModes).toEqual(['safe', 'ask', 'allow-all']);
  });
});

describe.skipIf(!CLAUDE_E2E)('ClaudeSdkDriver.listOptions (real local claude)', () => {
  it('returns models from the local Claude config (streaming input mode)', async () => {
    const { ClaudeSdkDriver } = await import(
      '../claude-sdk-driver.ts'
    );
    const options = await new ClaudeSdkDriver().listOptions();

    expect(options.models.length).toBeGreaterThan(0);
    expect(options.models[0]!.id.length).toBeGreaterThan(0);
    expect(options.permissionModes).toEqual(['safe', 'ask', 'allow-all']);
  });
});
