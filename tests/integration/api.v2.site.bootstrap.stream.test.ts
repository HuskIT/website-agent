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

describe('api.v2.site.bootstrap stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetV2Flags.mockReturnValue({
      mastraEnabled: true,
      waitingInsightsEnabled: false,
    });
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
    mockSearchRestaurant.mockResolvedValue({
      success: true,
      data: {
        name: 'Starbucks Reserve Roastery New York',
        place_id: 'place-123',
        data_id: 'data-123',
        address: '61 9th Ave, New York, NY 10011',
        website: 'https://www.starbucksreserve.com/',
      },
    });
    mockExtractBusinessData.mockResolvedValue({
      success: true,
      place_id: 'place-123',
      data: {
        website: 'https://www.starbucksreserve.com/',
      },
    });
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

  it('streams deterministic milestone events in order', async () => {
    const request = new Request('http://localhost/api/v2/site/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Starbucks',
        businessAddress: 'New York, NY',
      }),
    });

    const response = await action({ request } as any);
    const payload = await response.text();
    const events = parseSSEPayload(payload);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    expect(events.map((event) => event.event)).toEqual([
      'input_validated',
      'crawler_started',
      'generation_started',
      'preview_starting',
      'completed',
    ]);

    const inputValidated = events[0].data as Record<string, unknown>;
    const crawlerStarted = events[1].data as Record<string, unknown>;

    expect(inputValidated.placeId).toBe('place-123');
    expect(crawlerStarted.mode).toBe('real');
    expect(crawlerStarted.extractMethod).toBe('verified_place');
  });

  it('returns 400 for invalid bootstrap input', async () => {
    const request = new Request('http://localhost/api/v2/site/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await action({ request } as any);

    expect(response.status).toBe(400);
  });

  it('returns 503 when database preflight fails', async () => {
    mockRunV2DatabasePreflight.mockResolvedValue({
      ok: false,
      checkedAt: '2026-02-23T00:00:00.000Z',
      checks: {},
      warnings: [],
      error: 'Database preflight failed for V2 bootstrap prerequisites.',
    });

    const request = new Request('http://localhost/api/v2/site/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Starbucks',
        businessAddress: 'New York, NY',
      }),
    });

    const response = await action({ request } as any);
    const body = (await response.json()) as any;

    expect(response.status).toBe(503);
    expect(body.error.code).toBe('DATABASE_NOT_READY');
  });
});
