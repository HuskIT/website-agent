-- Crawl cache indexes for place_id lookups
-- Feature: crawl-data-reuse (cache + SerpAPI passthrough)

-- Index for top-level place_id lookups (new projects with place_id in business_profile)
CREATE INDEX IF NOT EXISTS idx_projects_bp_place_id
  ON projects USING btree ((business_profile->>'place_id'))
  WHERE business_profile->>'place_id' IS NOT NULL;

-- Index for nested place_metadata.place_id lookups (existing projects with place_id in crawled_data)
CREATE INDEX IF NOT EXISTS idx_projects_bp_crawled_place_id
  ON projects USING btree ((business_profile->'crawled_data'->'place_metadata'->>'place_id'))
  WHERE business_profile->'crawled_data'->'place_metadata'->>'place_id' IS NOT NULL;

-- Partial index on updated_at for TTL filtering (ORDER BY + LIMIT 1 optimization)
CREATE INDEX IF NOT EXISTS idx_projects_bp_updated_for_cache
  ON projects (updated_at DESC)
  WHERE business_profile IS NOT NULL
  AND business_profile->'crawled_data' IS NOT NULL;
