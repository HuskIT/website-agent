## Summary
- Add Langfuse integration for LLM call tracing and observability
- Integrate new crawler markdown generation endpoints for richer website generation context
- Add comprehensive tests for both features

## Test plan
- [ ] Verify Langfuse traces appear in dashboard when `LANGFUSE_ENABLED=true`
- [ ] Test markdown generation flow with and without website URL
- [ ] Run `pnpm test` to verify all unit/integration tests pass
- [ ] Test graceful degradation when website crawl fails

---

## Changes

### Langfuse LLM Observability Integration
- New telemetry module at `app/lib/.server/telemetry/langfuse.server.ts` with trace/span/generation helpers
- Feature flag control via `LANGFUSE_ENABLED` environment variable
- Graceful fallback when disabled or credentials missing
- Unit tests with 331 lines of coverage
- Environment variables added to `.env.example`

### Enhanced Markdown Crawler Integration
- Two new crawler client methods: `generateGoogleMapsMarkdown()` and `crawlWebsiteMarkdown()`
- Extended `BusinessProfile` type with `google_maps_markdown` and `website_markdown` fields
- Parallel markdown fetching in `app/routes/api.crawler.extract.ts` using `Promise.allSettled`
- Graceful degradation with explicit logging when website URL is unavailable
- Updated theme prompts to enforce strict markdown output format
- File watcher protection via `markFilesAsRecentlySaved()` to prevent overwrites

### Tests
- Integration tests for full markdown flow (7 test cases)
- Unit tests for markdown generation methods (9 test cases)
- Coverage for timeout, 404, 500, and network error scenarios

### Specs & Documentation
- `specs/001-langfuse-integration/` - Full feature spec and plan
- `specs/001-enhanced-markdown-crawler/` - Spec, plan, contracts, data model

🤖 Generated with [Claude Code](https://claude.com/claude-code)
