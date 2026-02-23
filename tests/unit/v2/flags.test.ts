import { afterEach, describe, expect, it } from 'vitest';
import { getV2Flags } from '~/lib/config/v2Flags';

const ENV_KEYS = [
  'V2_MASTRA_ENABLED',
  'V2_WAITING_INSIGHTS_ENABLED',
  'V2_WORKSPACE_ENABLED',
  'V2_MEMORY_ENABLED',
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = originalEnv[key];
  }
});

describe('v2Flags', () => {
  it('defaults all v2 flags to false', () => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }

    const flags = getV2Flags();

    expect(flags).toEqual({
      mastraEnabled: false,
      waitingInsightsEnabled: false,
      workspaceEnabled: false,
      memoryEnabled: false,
    });
  });

  it('parses explicit true values', () => {
    process.env.V2_MASTRA_ENABLED = 'true';
    process.env.V2_WAITING_INSIGHTS_ENABLED = 'true';
    process.env.V2_WORKSPACE_ENABLED = 'true';
    process.env.V2_MEMORY_ENABLED = 'true';

    const flags = getV2Flags();

    expect(flags.mastraEnabled).toBe(true);
    expect(flags.waitingInsightsEnabled).toBe(true);
    expect(flags.workspaceEnabled).toBe(true);
    expect(flags.memoryEnabled).toBe(true);
  });
});
