import { beforeEach, describe, expect, it, vi } from 'vitest';
import { action } from '~/routes/api.v2.site.bootstrap';

const mockGetSession = vi.fn();
const mockGetV2Flags = vi.fn();
const mockSearchRestaurant = vi.fn();
const mockExtractBusinessData = vi.fn();
const mockGenerateGoogleMapsMarkdown = vi.fn();
const mockCrawlWebsiteMarkdown = vi.fn();
const mockRunV2DatabasePreflight = vi.fn();

vi.mock('~/lib/auth/session.server', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

vi.mock('~/lib/config/v2Flags', () => ({
  getV2Flags: (...args: unknown[]) => mockGetV2Flags(...args),
}));

vi.mock('~/lib/services/crawlerClient.server', () => ({
  searchRestaurant: (...args: unknown[]) => mockSearchRestaurant(...args),
  extractBusinessData: (...args: unknown[]) => mockExtractBusinessData(...args),
  generateGoogleMapsMarkdown: (...args: unknown[]) => mockGenerateGoogleMapsMarkdown(...args),
  crawlWebsiteMarkdown: (...args: unknown[]) => mockCrawlWebsiteMarkdown(...args),
}));

vi.mock('~/lib/services/v2/databasePreflight.server', () => ({
  runV2DatabasePreflight: (...args: unknown[]) => mockRunV2DatabasePreflight(...args),
}));

interface ParsedSSEEvent {
  event: string;
  data: unknown;
}

function parseSSEPayload(payload: string): ParsedSSEEvent[] {
  return payload
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));

      if (!eventLine || !dataLine) {
        throw new Error(`Malformed SSE block: ${block}`);
      }

      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)),
      };
    });
}

describe('api.v2.site.bootstrap crawler integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.E2B_API_KEY;
    delete process.env.E2B_API_TOKEN;
    delete process.env.E2B_ACCESS_TOKEN;
    mockGetV2Flags.mockReturnValue({
      mastraEnabled: true,
      waitingInsightsEnabled: false,
      workspaceEnabled: false,
      memoryEnabled: false,
    });
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
    mockGenerateGoogleMapsMarkdown.mockResolvedValue({
      success: true,
      place_id: 'place-123',
      markdown: '# Google Maps markdown',
    });
    mockCrawlWebsiteMarkdown.mockResolvedValue({
      success: true,
      place_id: 'place-123',
      markdown: '# Website markdown',
    });
    mockRunV2DatabasePreflight.mockResolvedValue({
      ok: true,
      checkedAt: '2026-02-23T00:00:00.000Z',
      checks: {},
      warnings: [],
    });
  });

  it('uses search + verified extract payload for business name/address mode', async () => {
    mockSearchRestaurant.mockResolvedValue({
      success: true,
      data: {
        name: 'Verified Bistro',
        place_id: 'place-123',
        data_id: 'data-123',
        address: '123 Main St, New York',
        website: 'https://verified.example',
      },
    });
    mockExtractBusinessData.mockResolvedValue({
      success: true,
      place_id: 'place-123',
      data: {
        website: 'https://verified.example',
      },
    });

    const request = new Request('http://localhost/api/v2/site/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Input Bistro',
        businessAddress: 'Input Address',
      }),
    });

    const response = await action({ request } as any);
    const payload = await response.text();
    const events = parseSSEPayload(payload);

    expect(response.status).toBe(200);
    expect(mockSearchRestaurant).toHaveBeenCalledWith('Input Bistro', 'Input Address');
    expect(mockExtractBusinessData).toHaveBeenCalledWith(
      expect.objectContaining({
        place_id: 'place-123',
        business_name: 'Verified Bistro',
        address: '123 Main St, New York',
      }),
    );

    const crawlerEvent = events.find((event) => event.event === 'crawler_started');
    expect((crawlerEvent?.data as Record<string, unknown>).extractMethod).toBe('verified_place');
    expect((crawlerEvent?.data as Record<string, unknown>).hasGoogleMapsMarkdown).toBe(true);
  });

  it('uses mapsUrl extraction mode and skips search', async () => {
    mockSearchRestaurant.mockResolvedValue({
      success: false,
      error: 'should not be called',
    });
    mockExtractBusinessData.mockResolvedValue({
      success: true,
      place_id: 'place-map-url',
      data: {},
    });

    const request = new Request('http://localhost/api/v2/site/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Input Bistro',
        businessAddress: 'Input Address',
        mapsUrl: 'https://www.google.com/maps/place/xyz',
      }),
    });

    const response = await action({ request } as any);
    const payload = await response.text();
    const events = parseSSEPayload(payload);

    expect(response.status).toBe(200);
    expect(mockSearchRestaurant).not.toHaveBeenCalled();
    expect(mockExtractBusinessData).toHaveBeenCalledWith(
      expect.objectContaining({
        google_maps_url: 'https://www.google.com/maps/place/xyz',
      }),
    );

    const crawlerEvent = events.find((event) => event.event === 'crawler_started');
    expect((crawlerEvent?.data as Record<string, unknown>).extractMethod).toBe('maps_url');
  });

  it('falls back to name/address extraction when search fails', async () => {
    mockSearchRestaurant.mockResolvedValue({
      success: false,
      error: 'Not found',
    });
    mockExtractBusinessData.mockResolvedValue({
      success: true,
      place_id: 'place-fallback',
      data: {},
    });

    const request = new Request('http://localhost/api/v2/site/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Fallback Bistro',
        businessAddress: 'Fallback Address',
      }),
    });

    const response = await action({ request } as any);
    const payload = await response.text();
    const events = parseSSEPayload(payload);

    expect(response.status).toBe(200);
    expect(mockExtractBusinessData).toHaveBeenCalledWith(
      expect.objectContaining({
        business_name: 'Fallback Bistro',
        address: 'Fallback Address',
      }),
    );

    const crawlerEvent = events.find((event) => event.event === 'crawler_started');
    expect((crawlerEvent?.data as Record<string, unknown>).extractMethod).toBe('name_address');
    expect((crawlerEvent?.data as Record<string, unknown>).searchSuccess).toBe(false);
  });
});
