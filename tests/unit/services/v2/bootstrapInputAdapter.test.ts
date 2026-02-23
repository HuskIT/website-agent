import { describe, expect, it } from 'vitest';
import { adaptBootstrapInput } from '~/lib/services/v2/bootstrapInputAdapter';

describe('bootstrapInputAdapter', () => {
  it('maps search + extract + project profile into canonical V2 input', () => {
    const input = adaptBootstrapInput({
      project: {
        id: 'project-1',
        name: 'Old Project Name',
        business_profile: {
          place_id: 'old-place',
          session_id: 'old-session',
          gmaps_url: 'https://maps.google.com/old',
        },
      } as any,
      searchResult: {
        name: 'Bistro Nova',
        place_id: 'place-123',
        data_id: 'data-1',
        address: '123 Main St',
      },
      extractPayload: {
        place_id: 'place-123',
        session_id: 'session-777',
        google_maps_markdown: '# Maps',
        website_markdown: '# Site',
      },
      fallback: {
        mapsUrl: 'https://maps.google.com/new',
      },
    });

    expect(input.projectId).toBe('project-1');
    expect(input.businessName).toBe('Bistro Nova');
    expect(input.businessAddress).toBe('123 Main St');
    expect(input.placeId).toBe('place-123');
    expect(input.sessionId).toBe('session-777');
    expect(input.businessProfile?.google_maps_markdown).toBe('# Maps');
  });

  it('accepts fallback-only input for name/address bootstrap', () => {
    const input = adaptBootstrapInput({
      fallback: {
        businessName: 'Cafe Leaf',
        businessAddress: '99 Broadway',
        placeId: 'place-fallback',
      },
    });

    expect(input.businessName).toBe('Cafe Leaf');
    expect(input.businessAddress).toBe('99 Broadway');
    expect(input.placeId).toBe('place-fallback');
  });
});

