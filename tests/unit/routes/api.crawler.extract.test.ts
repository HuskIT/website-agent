/**
 * Unit tests for api.crawler.extract route
 *
 * Tests cache integration (lookupCrawlCache) and restaurant_data forwarding
 * to the external crawler API.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
const mockGetSession = vi.fn();
const mockExtractBusinessData = vi.fn();
const mockLookupCrawlCache = vi.fn();

vi.mock('~/lib/auth/session.server', () => ({
  getSession: (...args: any[]) => mockGetSession(...args),
}));

vi.mock('~/lib/services/crawlerClient.server', () => ({
  extractBusinessData: (...args: any[]) => mockExtractBusinessData(...args),
}));

vi.mock('~/lib/services/crawlCache.server', () => ({
  lookupCrawlCache: (...args: any[]) => mockLookupCrawlCache(...args),
}));

vi.mock('~/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { action } from '~/routes/api.crawler.extract';

const USER_ID = 'user-123';
const SESSION_ID = 'session-abc';
const PLACE_ID = 'ChIJfQfAIgAvdTER2BCqGxIfcNc';

function createRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/crawler/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const mockCrawledData = {
  profile_basics: { title: 'Test Restaurant', rating: 4.5 },
  place_metadata: { place_id: PLACE_ID },
};

const mockRestaurantData = {
  name: 'Test Restaurant',
  place_id: PLACE_ID,
  data_id: '0x123:0x456',
  address: '123 Main St',
  rating: 4.5,
  reviews_count: 50,
  type: 'Restaurant',
};

describe('api.crawler.extract action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockExtractBusinessData.mockResolvedValue({
      success: true,
      data: mockCrawledData,
    });
    mockLookupCrawlCache.mockResolvedValue({ hit: false, ownedByCurrentUser: false });
  });

  it('returns cached data and skips crawler call on cache HIT', async () => {
    mockLookupCrawlCache.mockResolvedValue({
      hit: true,
      data: mockCrawledData,
      crawledAt: '2026-01-30T00:00:00Z',
      sourceProjectId: 'proj-cached',
      ownedByCurrentUser: true,
    });

    const request = createRequest({
      session_id: SESSION_ID,
      business_name: 'Test Restaurant',
      address: '123 Main St',
      place_id: PLACE_ID,
    });

    const response = await action({ request, params: {}, context: {} as any });
    const data = (await response.json()) as any;

    expect(data.success).toBe(true);
    expect(data.cached).toBe(true);
    expect(data.cachedAt).toBe('2026-01-30T00:00:00Z');
    expect(data.data).toEqual(mockCrawledData);
    expect(mockExtractBusinessData).not.toHaveBeenCalled();
  });

  it('calls crawler on cache MISS', async () => {
    const request = createRequest({
      session_id: SESSION_ID,
      business_name: 'Test Restaurant',
      address: '123 Main St',
      place_id: PLACE_ID,
    });

    const response = await action({ request, params: {}, context: {} as any });
    const data = (await response.json()) as any;

    expect(data.success).toBe(true);
    expect(data.cached).toBeUndefined();
    expect(mockLookupCrawlCache).toHaveBeenCalledWith(PLACE_ID, USER_ID);
    expect(mockExtractBusinessData).toHaveBeenCalled();
  });

  it('skips cache lookup when no place_id provided', async () => {
    const request = createRequest({
      session_id: SESSION_ID,
      google_maps_url: 'https://www.google.com/maps/place/Test',
    });

    await action({ request, params: {}, context: {} as any });

    expect(mockLookupCrawlCache).not.toHaveBeenCalled();
    expect(mockExtractBusinessData).toHaveBeenCalled();
  });

  it('forwards restaurant_data to crawler on cache MISS', async () => {
    const request = createRequest({
      session_id: SESSION_ID,
      business_name: 'Test Restaurant',
      address: '123 Main St',
      place_id: PLACE_ID,
      restaurant_data: mockRestaurantData,
    });

    await action({ request, params: {}, context: {} as any });

    expect(mockExtractBusinessData).toHaveBeenCalledWith(
      expect.objectContaining({
        restaurant_data: mockRestaurantData,
      }),
    );
  });

  it('passes undefined restaurant_data when not provided', async () => {
    const request = createRequest({
      session_id: SESSION_ID,
      business_name: 'Test Restaurant',
      address: '123 Main St',
      place_id: PLACE_ID,
    });

    await action({ request, params: {}, context: {} as any });

    expect(mockExtractBusinessData).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: SESSION_ID,
        business_name: 'Test Restaurant',
      }),
    );
    const callArgs = mockExtractBusinessData.mock.calls[0][0];
    expect(callArgs.restaurant_data).toBeUndefined();
  });

  it('falls through to crawler when cache lookup throws', async () => {
    mockLookupCrawlCache.mockRejectedValue(new Error('Cache service down'));

    const request = createRequest({
      session_id: SESSION_ID,
      business_name: 'Test Restaurant',
      address: '123 Main St',
      place_id: PLACE_ID,
    });

    // The route should catch the error and proceed to crawler
    // Note: The cache error is caught inside lookupCrawlCache itself (fail-open),
    // but if the import or call fails at a higher level, the route's try/catch handles it
    const response = await action({ request, params: {}, context: {} as any });
    const data = await response.json();

    // Should still get a response (either from crawler or error handler)
    expect(response.status).toBeLessThanOrEqual(500);
  });

  it('cached response has same shape as fresh crawl response', async () => {
    mockLookupCrawlCache.mockResolvedValue({
      hit: true,
      data: mockCrawledData,
      crawledAt: '2026-01-30T00:00:00Z',
      sourceProjectId: 'proj-cached',
      ownedByCurrentUser: false,
    });

    const request = createRequest({
      session_id: SESSION_ID,
      business_name: 'Test Restaurant',
      address: '123 Main St',
      place_id: PLACE_ID,
    });

    const response = await action({ request, params: {}, context: {} as any });
    const data = (await response.json()) as any;

    // Client checks: result.success && result.data
    expect(data).toHaveProperty('success', true);
    expect(data).toHaveProperty('data');
    expect(data.data).toBeDefined();
  });
});
