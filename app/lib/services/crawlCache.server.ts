/**
 * Crawl Data Cache Service
 *
 * Provides cross-user, TTL-aware cache lookups for crawled business data.
 * Uses place_id to match previously crawled Google Maps locations stored
 * in the projects table's business_profile JSONB column.
 *
 * Two query strategies (ordered by speed):
 * 1. Top-level: business_profile->>'place_id' (new projects)
 * 2. Nested: business_profile->'crawled_data'->'place_metadata'->>'place_id' (existing projects)
 */

import { createSupabaseClient } from '~/lib/db/supabase.server';
import { logger } from '~/utils/logger';

export interface CrawlCacheResult {
  hit: boolean;
  data?: unknown;
  crawledAt?: string;
  sourceProjectId?: string;
  ownedByCurrentUser: boolean;
}

const TTL_DAYS = 7;

/**
 * Look up cached crawl data by place_id across ALL users.
 * Returns the most recent crawl within TTL.
 *
 * Uses the service role client (bypasses RLS) for cross-user reads.
 * Fails open: any error returns { hit: false } so crawling proceeds normally.
 */
export async function lookupCrawlCache(placeId: string, currentUserId: string): Promise<CrawlCacheResult> {
  try {
    const supabase = createSupabaseClient();

    const ttlCutoff = new Date();
    ttlCutoff.setDate(ttlCutoff.getDate() - TTL_DAYS);

    const cutoffIso = ttlCutoff.toISOString();

    // Query 1: Top-level place_id (fast, indexed via btree)
    const { data: topLevel } = await supabase
      .from('projects')
      .select('id, user_id, business_profile, updated_at')
      .eq('business_profile->>place_id', placeId)
      .not('business_profile->crawled_data', 'is', null)
      .gte('updated_at', cutoffIso)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (topLevel?.length) {
      const p = topLevel[0];

      return {
        hit: true,
        data: p.business_profile.crawled_data,
        crawledAt: p.business_profile.crawled_at,
        sourceProjectId: p.id,
        ownedByCurrentUser: p.user_id === currentUserId,
      };
    }

    // Query 2: Nested place_metadata.place_id (for existing data without top-level field)
    const { data: nested } = await supabase
      .from('projects')
      .select('id, user_id, business_profile, updated_at')
      .eq('business_profile->crawled_data->place_metadata->>place_id', placeId)
      .not('business_profile->crawled_data', 'is', null)
      .gte('updated_at', cutoffIso)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (nested?.length) {
      const p = nested[0];

      return {
        hit: true,
        data: p.business_profile.crawled_data,
        crawledAt: p.business_profile.crawled_at,
        sourceProjectId: p.id,
        ownedByCurrentUser: p.user_id === currentUserId,
      };
    }

    return { hit: false, ownedByCurrentUser: false };
  } catch (error) {
    // Fail open: cache errors should never block crawling
    logger.error('[CACHE] Cache lookup failed, falling through to crawl', {
      placeId,
      error: error instanceof Error ? error.message : String(error),
    });

    return { hit: false, ownedByCurrentUser: false };
  }
}
