import { describe, expect, it } from 'vitest';
import {
  buildV2RuntimeState,
  mergeBusinessProfileRuntime,
  readV2RuntimeState,
} from '~/lib/services/v2/runtimeMetadata';
import type { BusinessProfile } from '~/types/project';

describe('runtimeMetadata', () => {
  it('builds and parses v2 runtime state', () => {
    const state = buildV2RuntimeState({
      sandboxId: 'v2-project-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      previewUrl: 'https://preview.example',
      lifecycle: 'running',
      workspaceReused: true,
      buildAttempts: 1,
      warnings: [],
      memory: {
        enabled: true,
        resource_id: 'project:1',
        thread_id: 'bootstrap:1',
      },
      updatedAt: '2026-02-23T00:00:00.000Z',
    });
    const parsed = readV2RuntimeState({
      v2_runtime: state,
    } as BusinessProfile);

    expect(parsed?.provider).toBe('e2b');
    expect(parsed?.sandbox_id).toBe('v2-project-1');
    expect(parsed?.memory?.enabled).toBe(true);
  });

  it('returns undefined for invalid runtime payloads', () => {
    const parsed = readV2RuntimeState({
      v2_runtime: {
        provider: 'e2b',
        lifecycle: 'unknown',
      } as any,
    } as BusinessProfile);

    expect(parsed).toBeUndefined();
  });

  it('merges runtime state into business profile without dropping existing fields', () => {
    const merged = mergeBusinessProfileRuntime(
      {
        place_id: 'place-1',
        google_maps_markdown: '# maps',
      },
      buildV2RuntimeState({
        lifecycle: 'completed',
        updatedAt: '2026-02-23T01:00:00.000Z',
      }),
    );

    expect(merged.place_id).toBe('place-1');
    expect(merged.google_maps_markdown).toBe('# maps');
    expect(merged.v2_runtime?.lifecycle).toBe('completed');
  });
});
