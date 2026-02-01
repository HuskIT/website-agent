/**
 * Unit tests for Crawl Cache Service
 *
 * Tests lookupCrawlCache() with dual query strategy, TTL enforcement,
 * cross-user cache, and fail-open error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Create a chainable mock that returns itself for all query methods
// Terminal call (limit) returns { data, error }
let mockQueryResult: { data: any; error: any } = { data: null, error: null };
let queryCallCount = 0;

const createChainableMock = () => {
  const mock: any = {
    from: vi.fn(() => mock),
    select: vi.fn(() => mock),
    eq: vi.fn(() => mock),
    not: vi.fn(() => mock),
    gte: vi.fn(() => mock),
    order: vi.fn(() => mock),
    limit: vi.fn(() => {
      queryCallCount++;

      // Allow different results for Query 1 vs Query 2
      if (typeof mockQueryResult === 'function') {
        return (mockQueryResult as any)(queryCallCount);
      }

      return mockQueryResult;
    }),
  };

  return mock;
};

const mockSupabase = createChainableMock();

vi.mock('~/lib/db/supabase.server', () => ({
  createSupabaseClient: vi.fn(() => mockSupabase),
}));

vi.mock('~/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { lookupCrawlCache } from '~/lib/services/crawlCache.server';
import { logger } from '~/utils/logger';

const CURRENT_USER_ID = 'user-current-123';
const OTHER_USER_ID = 'user-other-456';
const PLACE_ID = 'ChIJfQfAIgAvdTER2BCqGxIfcNc';

const recentDate = new Date();
recentDate.setDate(recentDate.getDate() - 2); // 2 days ago

const mockProject = (overrides: Record<string, any> = {}) => ({
  id: 'proj-abc',
  user_id: CURRENT_USER_ID,
  business_profile: {
    place_id: PLACE_ID,
    crawled_data: { profile_basics: { title: 'Test Restaurant' } },
    crawled_at: recentDate.toISOString(),
  },
  updated_at: recentDate.toISOString(),
  ...overrides,
});

describe('lookupCrawlCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryCallCount = 0;
    mockQueryResult = { data: null, error: null };
  });

  it('returns cache HIT when top-level place_id matches (Query 1)', async () => {
    const proj = mockProject();
    mockQueryResult = { data: [proj], error: null };

    const result = await lookupCrawlCache(PLACE_ID, CURRENT_USER_ID);

    expect(result.hit).toBe(true);
    expect(result.data).toEqual(proj.business_profile.crawled_data);
    expect(result.crawledAt).toBe(proj.business_profile.crawled_at);
    expect(result.sourceProjectId).toBe('proj-abc');
    expect(result.ownedByCurrentUser).toBe(true);
    // Should only need Query 1 (1 limit call)
    expect(queryCallCount).toBe(1);
  });

  it('returns cache HIT from nested place_metadata when Query 1 misses (Query 2)', async () => {
    const proj = mockProject();

    // Query 1 returns empty, Query 2 returns match
    mockQueryResult = ((callNum: number) => {
      if (callNum === 1) {
        return { data: [], error: null };
      }

      return { data: [proj], error: null };
    }) as any;

    const result = await lookupCrawlCache(PLACE_ID, CURRENT_USER_ID);

    expect(result.hit).toBe(true);
    expect(result.data).toEqual(proj.business_profile.crawled_data);
    expect(queryCallCount).toBe(2);
  });

  it('returns cache MISS when no matching place_id found', async () => {
    mockQueryResult = ((callNum: number) => ({ data: [], error: null })) as any;

    const result = await lookupCrawlCache(PLACE_ID, CURRENT_USER_ID);

    expect(result.hit).toBe(false);
    expect(result.data).toBeUndefined();
    expect(queryCallCount).toBe(2);
  });

  it('enforces TTL — expired data returns cache MISS', async () => {
    // Both queries return empty because the gte filter excludes expired entries
    mockQueryResult = ((callNum: number) => ({ data: [], error: null })) as any;

    const result = await lookupCrawlCache(PLACE_ID, CURRENT_USER_ID);

    expect(result.hit).toBe(false);
    // Verify gte was called (TTL cutoff applied)
    expect(mockSupabase.gte).toHaveBeenCalled();
  });

  it('returns ownedByCurrentUser: false for cross-user cache hit', async () => {
    const proj = mockProject({ user_id: OTHER_USER_ID });
    mockQueryResult = { data: [proj], error: null };

    const result = await lookupCrawlCache(PLACE_ID, CURRENT_USER_ID);

    expect(result.hit).toBe(true);
    expect(result.ownedByCurrentUser).toBe(false);
  });

  it('returns ownedByCurrentUser: true for same-user cache hit', async () => {
    const proj = mockProject({ user_id: CURRENT_USER_ID });
    mockQueryResult = { data: [proj], error: null };

    const result = await lookupCrawlCache(PLACE_ID, CURRENT_USER_ID);

    expect(result.hit).toBe(true);
    expect(result.ownedByCurrentUser).toBe(true);
  });

  it('fails open on Supabase query error — returns cache MISS', async () => {
    mockQueryResult = { data: null, error: { message: 'connection error' } };
    // Make limit throw to simulate a network error
    mockSupabase.limit.mockImplementationOnce(() => {
      throw new Error('Supabase connection refused');
    });

    const result = await lookupCrawlCache(PLACE_ID, CURRENT_USER_ID);

    expect(result.hit).toBe(false);
    expect(result.ownedByCurrentUser).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      '[CACHE] Cache lookup failed, falling through to crawl',
      expect.objectContaining({ placeId: PLACE_ID }),
    );
  });

  it('fails open when createSupabaseClient throws (e.g., missing env vars)', async () => {
    const { createSupabaseClient } = await import('~/lib/db/supabase.server');
    (createSupabaseClient as any).mockImplementationOnce(() => {
      throw new Error('Missing Supabase configuration');
    });

    const result = await lookupCrawlCache(PLACE_ID, CURRENT_USER_ID);

    expect(result.hit).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it('prefers most recent project (order by updated_at DESC)', async () => {
    const proj = mockProject();
    mockQueryResult = { data: [proj], error: null };

    await lookupCrawlCache(PLACE_ID, CURRENT_USER_ID);

    // Verify order was called with descending
    expect(mockSupabase.order).toHaveBeenCalledWith('updated_at', { ascending: false });
  });

  it('skips projects without crawled_data (not filter applied)', async () => {
    mockQueryResult = ((callNum: number) => ({ data: [], error: null })) as any;

    await lookupCrawlCache(PLACE_ID, CURRENT_USER_ID);

    // Verify the not filter for crawled_data was applied
    expect(mockSupabase.not).toHaveBeenCalledWith('business_profile->crawled_data', 'is', null);
  });
});
