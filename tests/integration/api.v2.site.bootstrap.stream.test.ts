import { beforeEach, describe, expect, it, vi } from 'vitest';
import { action } from '~/routes/api.v2.site.bootstrap';

const mockGetSession = vi.fn();
const mockGetV2Flags = vi.fn();

vi.mock('~/lib/auth/session.server', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

vi.mock('~/lib/config/v2Flags', () => ({
  getV2Flags: (...args: unknown[]) => mockGetV2Flags(...args),
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

    expect((events[0].data as Record<string, unknown>).businessName).toBe('Starbucks');
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
});
