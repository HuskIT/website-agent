import { describe, expect, it } from 'vitest';
import {
  V2BootstrapRequestSchema,
  V2BootstrapSSEEventSchema,
  V2EditRequestSchema,
  V2EditResponseSchema,
} from '~/lib/services/v2/contracts';

describe('v2 contracts', () => {
  it('accepts Flow-A compatible bootstrap payload', () => {
    const parsed = V2BootstrapRequestSchema.parse({
      projectId: 'project-123',
      businessName: 'Bistro Nova',
      businessAddress: '123 Main St, New York',
      placeId: 'place-xyz',
      sessionId: 'session-abc',
      businessProfile: {
        place_id: 'place-xyz',
        session_id: 'session-abc',
        google_maps_markdown: '# Google Maps markdown',
        website_markdown: '# Website markdown',
        v2_runtime: {
          provider: 'e2b',
          sandbox_id: 'v2-project-123',
          lifecycle: 'running',
          updated_at: '2026-02-23T00:00:00.000Z',
          memory: {
            enabled: true,
            resource_id: 'project:project-123',
            thread_id: 'bootstrap:session-abc',
          },
        },
      },
    });

    expect(parsed.businessProfile?.place_id).toBe('place-xyz');
    expect(parsed.businessProfile?.v2_runtime?.provider).toBe('e2b');
  });

  it('rejects empty bootstrap payload', () => {
    const result = V2BootstrapRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('validates bootstrap SSE event shape', () => {
    const event = V2BootstrapSSEEventSchema.parse({
      event: 'generation_started',
      data: { projectId: 'project-1' },
    });

    expect(event.event).toBe('generation_started');
  });

  it('validates edit request/response contracts', () => {
    const request = V2EditRequestSchema.parse({
      projectId: 'project-123',
      prompt: 'Update menu pricing',
      planId: 'plan-1',
    });

    const response = V2EditResponseSchema.parse({
      success: true,
      status: 'preview',
      projectId: 'project-123',
      planId: 'plan-1',
    });

    expect(request.projectId).toBe('project-123');
    expect(response.status).toBe('preview');
  });
});
