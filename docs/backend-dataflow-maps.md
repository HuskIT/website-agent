# Backend Data Flow: Crawler to Website Generation

> Maps the complete backend pipeline from post-login onboarding through Google Maps data extraction, content transformation, and template-based website generation.

---

## Table of Contents

1. [End-to-End Overview](#1-end-to-end-overview)
2. [Post-Login Routing & Onboarding](#2-post-login-routing--onboarding)
3. [Crawler Integration](#3-crawler-integration)
4. [Content Transformation](#4-content-transformation)
5. [Website Generation Pipeline](#5-website-generation-pipeline)
6. [Data Pre/Post-Processing Between Steps](#6-data-prepost-processing-between-steps)
7. [SSE Protocol & Events](#7-sse-protocol--events)
8. [Alternative Flow: Chat-Based Generation](#8-alternative-flow-chat-based-generation)
9. [API Route Reference](#9-api-route-reference)
10. [Key Data Structures](#10-key-data-structures)
11. [Error Handling](#11-error-handling)
12. [Observability (Langfuse)](#12-observability-langfuse)
13. [LLM Intelligence Pipeline](#13-llm-intelligence-pipeline)

---

## 1. End-to-End Overview

```
LOGIN
  |
  v
POST-LOGIN ROUTING (_index.tsx)
  |-- Has projects? --> /app (dashboard)
  |-- No projects?  --> /app/projects/new (onboarding wizard)
  |
  v
ONBOARDING WIZARD (3 steps, 5 internal states)
  Step 1: Business name + address
          --> POST /api/crawler/search --> verify_search step
  Step 2: Google Maps URL (manual fallback)
          --> POST /api/crawler/extract
  Step 3: Auto-build (crawling --> building, no review step)
  |
  v
PROJECT CREATION (POST /api/projects)
  -- Stores business_profile JSONB on projects table
  |
  v
WEBSITE GENERATION (POST /api/project/generate) [SSE stream]
  |
  +-- Phase 1: TEMPLATE SELECTION (fast LLM)
  |     analyzeBusinessProfile()
  |       --> inferPriceTier(), inferStyle(), extractStyleKeywords()
  |     buildTemplateSelectionContextPrompt()
  |       --> POST /api/llmcall
  |     parseTemplateSelection()
  |       --> TemplateSelection { themeId, name, reasoning }
  |
  +-- Phase 2: CONTENT GENERATION (user's LLM)
  |     resolveTemplate() --> zip-first, GitHub fallback
  |     --> applyIgnorePatterns()
  |     --> buildTemplatePrimingMessages()
  |     --> composeContentPrompt()
  |           --> (markdown path) inject google_maps_markdown + website_markdown
  |           --> (legacy path) formatBusinessDataForPrompt()
  |               --> formatMenuForPrompt(), formatReviewsForPrompt()
  |               --> formatPhotosForPrompt(), formatColorPaletteForPrompt()
  |               --> formatTypographyForPrompt()
  |     --> streamText() with theme prompt injection
  |     --> extractFileActionsFromBuffer() --> yield GeneratedFile[]
  |           --> normalizeFilePath(), cleanBoltFileContent()
  |
  +-- Phase 3: SNAPSHOT SAVE
  |     buildFileMapFromGeneratedFiles()
  |       --> normalizeFilePath() per file, dedup (last write wins)
  |     --> saveSnapshot() --> Upsert to project_snapshots table
  |
  v
CLIENT: Receive SSE file events --> workbenchStore.createFile() --> Preview
  |
  v
REDIRECT to /chat/{url_id} for iterative editing
```

---

## 2. Post-Login Routing & Onboarding

### 2.1 Post-Login Redirect

**File:** `app/routes/_index.tsx`

```
Authenticated user hits /
  |
  +--> getProjectsByUserId(userId, { limit: 1 })
  |
  +--> total > 0  -->  redirect('/app')            -- Dashboard
  +--> total === 0 --> redirect('/app/projects/new') -- Onboarding
```

**File:** `app/routes/app._index.tsx`

For fresh logins (`?login=true`), checks project count again and redirects first-time users to `/app/projects/new`.

### 2.2 Onboarding Wizard

**File:** `app/routes/app.projects.new.tsx` / `app/components/projects/CreateProjectPage.tsx`

The wizard has 5 internal states managed by a `Step` type:

```typescript
type Step = 'details' | 'verify_search' | 'maps' | 'crawling' | 'building';
```

These map to 3 visual progress steps:

| Visual Step | Internal States | Input | What Happens |
|-------------|----------------|-------|--------------|
| 1 | `details`, `verify_search` | Business name + address | Search API finds business, user confirms or rejects |
| 2 | `maps`, `crawling` | Google Maps URL (manual) | Direct URL crawl, auto-proceeds to building |
| 3 | `building` | (automatic) | Project creation + SSE generation stream |

#### Step flow:

```
details
  |
  +--> handleContinueDetails()
  |      POST /api/crawler/search { business_name, address }
  |      |
  |      +--> Success: setSearchResult(data) --> verify_search
  |      +--> Failure: show error, stay on details
  |
  v
verify_search (shows matched business card)
  |
  +--> handleConfirmVerified()
  |      executeCrawl({ business_name, address, place_id })
  |      --> crawling --> handleAutoBuild() --> building
  |
  +--> handleRejectVerified()
  |      --> maps (manual URL entry)
  |
  v
maps (fallback: manual Google Maps URL entry)
  |
  +--> handleSubmitMaps()
  |      executeCrawl({ google_maps_url })
  |      --> crawling --> handleAutoBuild() --> building
  |
  v
crawling (automatic, shows progress indicators)
  |
  +--> POST /api/crawler/extract { session_id, ...payload }
  |      |
  |      +--> Success: AUTO-PROCEED to handleAutoBuild(data)
  |      +--> Failure: back to maps step with error
  |
  v
building (project creation + generation)
  |
  +--> handleAutoBuild(crawledData)
  |      1. Build businessProfile { session_id, gmaps_url, crawled_data, crawled_at,
  |           google_maps_markdown?, website_markdown? }
  |      2. createProject(payload)  -->  POST /api/projects
  |      3. setCreatedProject(project) --> triggers generation useEffect
  |
  +--> useEffect: POST /api/project/generate { projectId }
  |      SSE stream --> handleEvent() per event type
  |      |
  |      +--> progress    --> setGenerationProgress()
  |      +--> template_selected --> setSelectedTemplate()
  |      +--> file        --> setGeneratedFiles(prev => [...prev, file])
  |      +--> complete    --> setGenerationComplete()
  |      +--> error       --> setGenerationError()
  |
  +--> useEffect (completion handler):
  |      workbenchStore.createFile() for each file
  |      navigate('/chat/{url_id}')
```

### 2.3 Project Creation Payload

```
POST /api/projects
{
  name: businessName,                    // from crawled data or user input
  gmaps_url: mapsUrl || undefined,       // only if URL was provided
  address: { line1: businessAddress },
  session_id: uuid,
  businessProfile: {
    session_id,
    gmaps_url: mapsUrl || undefined,
    crawled_data: BusinessData,          // raw from crawler
    crawled_at: ISO timestamp,
    google_maps_markdown?: string,       // LLM-processed markdown (from PR #30)
    website_markdown?: string            // Website analysis (from PR #30)
  }
}
```

The `business_profile` is stored as a JSONB column directly on the `projects` table.

**Note:** The `generated_content` field (AI-enhanced content from `/generate-website-content`) is NOT populated during onboarding — only `crawled_data` is set. However, `google_maps_markdown` and `website_markdown` are populated during the extract step (PR #30). The generation pipeline prefers markdown data when available, falling back to structured `crawled_data`.

---

## 3. Crawler Integration

Six crawler endpoints exist, used at different stages:

### 3.1 Business Search (New — PR #27)

**Files:**
- Route: `app/routes/api.crawler.search.ts`
- Client: `app/lib/services/crawlerClient.server.ts` → `searchRestaurant()`

```
POST /api/crawler/search
  { business_name, address }
      |
      v
  Authentication check (getSession)
      |
      v
  Input validation:
    - business_name: non-empty string
    - address: non-empty string
      |
      v
  searchRestaurant(business_name, address)
      |
      v
  POST {CRAWLER_API_URL}/search-restaurant  (timeout: 5 min)
      |
      v
  Response: SearchRestaurantResponse
    { success, data?: VerifiedRestaurantData }
      |
      v
  VerifiedRestaurantData:
    { name, place_id, data_id, address,
      phone?, website?, coordinates? }
```

Used in onboarding Step 1 to verify the business exists on Google Maps before crawling.

### 3.2 External Crawler (Production)

**Files:**
- Route: `app/routes/api.crawler.extract.ts`
- Client: `app/lib/services/crawlerClient.server.ts` → `extractBusinessData()`

**Extract flow — supports multiple input methods:**

```
POST /api/crawler/extract
  { session_id, google_maps_url?, business_name?, address?, website_url?, place_id? }
      |
      v
  Authentication check (getSession)
      |
      v
  Input validation (at least ONE required):
    Method 1: google_maps_url (valid URL, hostname: google.com | maps.app.goo.gl | goo.gl)
    Method 2: business_name + address (both non-empty strings)
    Method 3: website_url (non-empty string)
      |
      v
  extractBusinessData(payload)
      |
      v
  POST {CRAWLER_API_URL}/crawl  (timeout: 5 min / 300s)
      |
      v
  CrawlResponse { success, data?: BusinessData }
    BusinessData:
      { name, address, phone, website, rating,
        reviews_count, hours, reviews[], menu, photos[] }
      |
      v
  ─── Parallel Markdown Generation ──────────────────────
  After successful /crawl, generate markdown in parallel:
      |
      Promise.allSettled([
        generateGoogleMapsMarkdown(sessionId),
        crawlWebsiteMarkdown({ url, session_id, enable_visual_analysis: true })
      ])
      |
      v
  generateGoogleMapsMarkdown(sessionId)
    POST {CRAWLER_API_URL}/generate-google-maps-markdown  (timeout: 120s)
    --> GenerateGoogleMapsMarkdownResponse { success, markdown? }
      |
  crawlWebsiteMarkdown(request)  (skipped if no website URL)
    POST {CRAWLER_API_URL}/crawl-website-markdown  (timeout: 120s)
    --> CrawlWebsiteMarkdownResponse { success, data?: { markdown, session_id, url } }
      |
      v
  Graceful degradation:
    - Missing website URL: skip, log info
    - Website crawl fails: proceed with Google Maps data only, log warning
    - Both fail: generation still proceeds with structured BusinessData
      |
      v
  Combined Response (backward-compatible):
    {
      success: true,
      session_id,
      data: BusinessData,              // Original structured data
      google_maps_markdown?: string,   // LLM-processed markdown profile
      website_markdown?: string,       // Website analysis with visual descriptions
      has_website: boolean
    }
```

**Generate flow (separate endpoint, called independently):**

```
POST /api/crawler/generate
  { session_id }
      |
      v
  generateWebsiteContent(session_id)
      |
      v
  POST {CRAWLER_API_URL}/generate-website-content  (timeout: 5 min)
      |
      v
  Response: GenerateContentResponse { success, session_id, data?: GeneratedContent }
    GeneratedContent:
      { brandStrategy, visualAssets, businessIdentity,
        industryContext, reputationData, contentSections,
        extractedData }
```

### 3.3 Google Maps Markdown Generation (New — PR #30)

**Files:**
- Client: `app/lib/services/crawlerClient.server.ts` → `generateGoogleMapsMarkdown()`
- Called from: `app/routes/api.crawler.extract.ts` (parallel with website markdown)

```
generateGoogleMapsMarkdown(sessionId)
    |
    v
  POST {CRAWLER_API_URL}/generate-google-maps-markdown  (timeout: 120s)
    { session_id }
    |
    v
  Response: GenerateGoogleMapsMarkdownResponse
    { success, markdown?: string }
```

Prerequisites: `extractBusinessData()` must have been called with the same `session_id`. The crawler API caches results per session.

### 3.4 Website Markdown Crawling (New — PR #30)

**Files:**
- Client: `app/lib/services/crawlerClient.server.ts` → `crawlWebsiteMarkdown()`
- Called from: `app/routes/api.crawler.extract.ts` (parallel with Google Maps markdown)

```
crawlWebsiteMarkdown({ url, session_id, max_pages?, enable_visual_analysis? })
    |
    v
  POST {CRAWLER_API_URL}/crawl-website-markdown  (timeout: 120s)
    { url, session_id, max_pages: 1, enable_visual_analysis: true }
    |
    v
  Response: CrawlWebsiteMarkdownResponse
    { success, data?: { markdown, session_id, url } }
```

Uses LLM Vision to describe images, layout, and visual style of the restaurant's existing website. Skipped entirely if no website URL is found in crawler data.

### 3.5 Mock Crawler (Fallback)

**File:** `app/lib/services/crawlerService.ts`

Used when the real crawler is unavailable. Generates data from user description.

```
getMockCrawlerData(dataPackage)
  |
  +--> detectCuisine(description) -- keyword matching
  |      Returns: vietnamese | chinese | japanese | thai | italian | etc.
  |
  +--> extractBusinessName(description) -- pattern matching
  |      Quoted names, "called X", "named X", or cuisine placeholder
  |
  +--> CUISINE_PROFILES[cuisine] lookup
  |      Returns: { category, priceTier, toneOfVoice, visualStyle,
  |                  typographyVibe, primaryColor, accentColor,
  |                  isDarkMode, tagline, usp, targetAudience }
  |
  v
  CrawlerOutput (production_master_map schema)
```

### 3.6 Internal Places Service (Advanced)

**Files:**
- Agent: `app/lib/services/crawlerAgent.server.ts`
- Client: `app/lib/services/internalPlacesClient.server.ts`
- Schema: `app/lib/services/crawlerAgent.schema.ts`

Provides caching, provenance tracking, and quota management.

```
executeCrawl(request, authenticatedTenantId)
  |
  +--> Verify tenant scope (prevent cross-tenant access)
  |
  +--> normalizeGoogleMapsUrl(url)
  |      Extract placeId from: /maps/place/..., ?cid=..., shortened URLs
  |
  +--> lookupCachedCrawl(tenantId, placeId)
  |      Query: crawled_data table WHERE status='completed' AND cache not expired
  |      |
  |      +--> Cache HIT  --> Return cached CrawlResult
  |      +--> Cache MISS --> Continue
  |
  +--> fetchPlaceProfile(request)  -- internalPlacesClient
  |      POST /crawler/fetch (30s timeout, Bearer token auth)
  |
  +--> persistCrawlResult(result, rawPayload, ttlHours)
  |      Upsert to crawled_data table with TTL
  |
  v
  CrawlResult {
    tenantId, placeId, sourcesUsed[], freshness,
    cacheHit, sections{}, missingSections[],
    quotaState?, error?
  }
```

**Provenance tracking:** Every data section includes source type (`maps` | `website` | `social`), timestamp, and confidence score.

**Quota management:** Tracks API usage with states: `healthy` | `warning` | `exhausted`.

### 3.7 Info Collection Service

**Files:**
- Service: `app/lib/services/infoCollectionService.server.ts`
- Route: `app/routes/api.info-collection.ts`
- Types: `app/types/info-collection.ts`

Manages multi-step data collection sessions stored in the database.

**Session lifecycle:**

```
createSession(userId, chatId?)
  status: in_progress, step: website_url
    |
    v
updateWebsiteUrl(id, url, validated)  --> step: google_maps_url
    |
    v
updateGoogleMapsUrl(id, url, validated) --> step: description
    |
    v
updateDescription(id, description) --> step: review
    |
    v
completeSession(id) --> status: crawler_queued
  Returns: CrawlerDataPackage { sessionId, userId,
           websiteUrl, googleMapsUrl, userDescription, createdAt }
    |
    v
updateCrawlerOutput(id, jobId, output) --> status: crawler_completed
```

---

## 4. Content Transformation

**File:** `app/lib/services/contentTransformer.ts`

Transforms `CrawlerOutput` + `themeId` into template-ready `TemplateContent`.

```
transformToTemplateContent(crawlerOutput, themeId)
  |
  +--> THEME_CONFIGS[themeId] lookup
  |      { heroCtaLabel, menuHeading, aboutHeading,
  |        testimonialHeading, eyebrowStyle }
  |
  +--> Generate sections:
  |      hero:       generateEyebrow() + generateHeadline() + generateSubheadline()
  |      about:      generateAboutBody() from USP + description
  |      menu:       generateMenuItems() -- cuisine-specific items
  |      testimonials: generateTestimonials() -- placeholder reviews
  |      contact:    from nap_logistics
  |      social:     from social_ecosystem
  |      brand:      { name, tagline, colors: { primary, accent }, isDarkMode }
  |
  v
  TemplateContent {
    seo, navigation, hero, about, menuHighlights,
    testimonials?, contact, social, footer, brand
  }
```

**Output serialization:**

```typescript
// serializeContent(content) --> JSON string (pretty-printed)
// generateContentFileCode(content) --> TypeScript module:
export const siteContent = { ... };
export default siteContent;
```

> **Note:** The content transformer is used by the older `websiteGenerationService.ts` pipeline. The newer `projectGenerationService.ts` injects business data directly into LLM prompts instead of producing an intermediate `TemplateContent` object.

---

## 5. Website Generation Pipeline

**Files:**
- Route: `app/routes/api.project.generate.ts`
- Service: `app/lib/services/projectGenerationService.ts`
- Templates: `app/lib/.server/templates/` (template-resolver.ts, zip-template-fetcher.ts, github-template-fetcher.ts, template-primer.ts)
- LLM streaming: `app/lib/.server/llm/stream-text.ts`
- Telemetry: `app/lib/.server/telemetry/langfuse.server.ts`
- Theme registry: `app/theme-prompts/registry.ts`

### 5.1 Entry Point

```
POST /api/project/generate  { projectId, model?, provider? }
  |
  +--> requireSessionOrError(request)
  +--> getProjectById(projectId, userId)
  +--> Enrich business_profile (fallback to project.name if no crawler data)
  +--> validateBusinessProfile(enrichedProfile) -- requires business name
  +--> Resolve model/provider from body or defaults
  |
  v
  generateProjectWebsite(projectId, userId, options)
    -- Returns AsyncGenerator<GenerationSSEEvent>
    -- Route wraps in ReadableStream SSE response
    -- 5s heartbeat interval prevents timeout
```

### 5.2 Phase 1: Template Selection

**Function:** `selectTemplate(businessProfile, fastModel, provider, baseUrl, cookieHeader)`

```
analyzeBusinessProfile(profile)
  |
  +--> Extract: cuisine, category, priceTier, style, keywords, rating
  |    - cuisine: from generated_content.industryContext.categories + menu categories
  |    - priceTier: inferPriceTier() from pricing string or rating heuristic
  |    - style: inferStyle() from category/cuisine/tone/reviews keywords
  |
  v
POST /api/llmcall (fast model, e.g. gemini-2.5-flash)
  System prompt:
    - 12 templates listed as XML: <template><name>, <description>, <cuisines>, <style>
    - Selection criteria: cuisine > price tier > brand style > ambiance
    - Response format: <selection><templateName><reasoning><title>
  Context prompt:
    - Business name, category, cuisine, priceTier, style, keywords, tone, rating, menu
  |
  v
parseTemplateSelection(llmOutput)
  +--> Extract <templateName>, <reasoning>, <title> via regex
  +--> getThemeByTemplateName(templateName) -- lookup in RESTAURANT_THEMES
  +--> Fallback: 'classicminimalistv2' if parse/lookup fails
  |
  v
TemplateSelection { themeId, name, title, reasoning }
```

**Available templates (12):**

| Template | Cuisines | Style |
|----------|----------|-------|
| Artisan Hearth v3 | American, farm-to-table | Rustic |
| Bamboo Bistro | Asian, casual | Night market |
| Bold Feast v2 | American, contemporary | Industrial |
| Chromatic Street | Street food | Vibrant, urban |
| Classic Minimalist v2 | Fine dining | Scandinavian |
| Dynamic Fusion | Fusion, molecular | Modern |
| Fresh Market | Mediterranean | Farmers market |
| Gastrobotanical | Botanical, herbal | Garden |
| Indochine Luxe | Vietnamese | Colonial luxury |
| Noir Luxe v3 | Fine dining | Dark, gold accents |
| Saigon Veranda | Vietnamese | Street + French cafe |
| The Red Noodle | Asian, noodle house | Communal |

### 5.3 Phase 2: Content Generation

**Function:** `generateContent(businessProfile, themeId, model, provider, env, apiKeys, providerSettings)`

```
Step A: Resolve template (zip-first, GitHub fallback)
  resolveTemplate(templateName, { githubRepo, githubToken })
    |
    +--> Check filesystem available? (cached, false on Cloudflare Workers)
    |      |
    |      +--> YES: getZipPath(templateName) --> /templates/{slug}.zip
    |      |     zipExists(path) --> fetchTemplateFromZip(path)
    |      |       +--> Extract files, skip binaries, strip root folder
    |      |       +--> Return ResolvedTemplate { files, source: { type: 'zip' } }
    |      |
    |      +--> NO or zip fails: fall through to GitHub
    |
    +--> fetchTemplateFromGitHub(githubRepo, githubToken)  [fallback]
    |      +--> Download repo as zipball (GitHub API)
    |      +--> Extract files, exclude: .git, lock files, binaries, >100KB
    |      +--> Return ResolvedTemplate { files, source: { type: 'github' } }
    |
    v
  applyIgnorePatterns(allFiles)
    +--> Read .bolt/ignore from template, or use defaults
    +--> Defaults skip: config files, UI lib components, public assets
    +--> Split into: includedFiles[] + ignoredFiles[]

Step B: Build priming messages
  buildTemplatePrimingMessages(includedFiles, ignoredFiles, profile, templateName, themePrompt, title)
    |
    +--> assistantMessage:
    |      <boltArtifact id="imported-files" title="{title}" type="bundled">
    |        <boltAction type="file" filePath="{path}">{content}</boltAction>
    |        ...
    |      </boltArtifact>
    |
    +--> userMessage:
    |      TEMPLATE INSTRUCTIONS: {themePrompt}
    |      STRICT FILE ACCESS RULES: (read-only files)
    |      BUSINESS DATA TO INJECT: (name, contact, hours, menu, reviews, brand)
    |      CUSTOMIZATION TASK: Modify existing files, replace placeholders

Step C: Yield template files FIRST
  extractFileActionsFromBuffer(assistantMessage)
    --> yield each template file as { event: 'file', data: GeneratedFile }
    (These form the base snapshot; LLM modifications overwrite them)

Step D: Stream LLM response
  streamText({
    messages: [assistant (template), user (instructions)],
    chatMode: 'build',
    restaurantThemeId: themeId,
    additionalSystemPrompt: composeContentPrompt(profile, themePrompt)
  })
    |
    v
  Read textStream incrementally
    --> extractFileActionsFromBuffer(buffer)
    --> yield modified files as { event: 'file', data: GeneratedFile }
    (LLM files overwrite template files with same path)
```

### 5.4 Phase 3: Snapshot Save

```
buildFileMapFromGeneratedFiles(files)
  |
  +--> Normalize all paths to /home/project/...
  +--> Deduplicate: last write wins (LLM overwrites template)
  +--> Add folder entries for directory structure
  +--> Log overwrites with [FILE_MAP] warnings
  |
  v
  FileMap { [path]: { type: 'file', content, isBinary } | { type: 'folder' } }
      |
      v
  saveSnapshot(projectId, { files: fileMap }, userId)
    +--> Validate: max 50MB, warn at 45MB
    +--> Upsert to project_snapshots (one snapshot per project)
    +--> Returns: { updated_at }
```

---

## 6. Data Pre/Post-Processing Between Steps

This section details every data transformation function that runs between the crawler output and the LLM prompt. All functions are in `app/lib/services/projectGenerationService.ts` unless noted.

### 6.1 Business Profile Validation

**Function:** `validateBusinessProfile(profile)`

Called before generation starts. Returns `{ valid, errors[], warnings[], canProceedWithDefaults }`.

```
Input: BusinessProfile | null | undefined
  |
  +--> null/undefined --> { valid: false, errors: ['No business profile data'] }
  |
  +--> Check data availability:
  |      hasLegacyData = crawled_data.name OR generated_content.businessIdentity.displayName
  |      hasMarkdown = !!google_maps_markdown
  |
  +--> If neither legacy data NOR markdown:
  |      --> error: 'Business data is required (crawled_data or google_maps_markdown)'
  |
  +--> Warnings (non-blocking):
  |      - No website data (neither website_markdown nor crawled_data.website)
  |      - No address
  |      - No phone
  |      - No hours
  |
  v
  Result: { valid: true/false, canProceedWithDefaults: true if no errors }
```

### 6.2 Business Profile Analysis (Phase 1 preprocessing)

**Function:** `analyzeBusinessProfile(profile)` → `BusinessProfileAnalysis`

Extracts structured attributes from the raw business profile for template selection.

```
Input: BusinessProfile
  |
  +--> categories = generated_content.industryContext.categories (or [])
  +--> category = categories[0] || 'restaurant'
  |
  +--> cuisine candidates:
  |      1. industryContext.categories (lowercased)
  |      2. crawled_data.menu.categories[].name (lowercased)
  |      cuisine = first non-empty candidate || category
  |
  +--> rating = generated_content.reputationData.averageRating
  |              || crawled_data.rating
  +--> reviewsCount = generated_content.reputationData.reviewsCount
  |                    || crawled_data.reviews_count
  |
  +--> priceTier = inferPriceTier({ pricingTier, rating })
  |      '$$$$/lux/premium' --> luxury
  |      '$$$/fine/upscale'  --> upscale
  |      '$$/mid'            --> mid
  |      '$/budget/cheap'    --> budget
  |      (no match) rating >= 4.7 --> upscale, >= 4.3 --> mid, else --> mid
  |
  +--> style = inferStyle({ category, cuisine, pricingTier, tone, visualStyle, reviewText })
  |      'street/food truck/noodle' --> vibrant
  |      'fine dining/lux/tasting'  --> elegant
  |      'botanical/garden/fresh'   --> fresh
  |      'rustic/farm/hearth'       --> rustic
  |      'dark/noir/gold'           --> dark-luxe
  |      'minimal/clean/scandinavian' --> minimalist
  |      (default)                  --> modern
  |
  +--> keywords = deduplicated list (max 12) of:
  |      [category, cuisine, priceTier, style,
  |       extractStyleKeywords(reviewText),
  |       extractStyleKeywords(tone + visualStyle)]
  |
  v
  BusinessProfileAnalysis {
    cuisine, category, priceTier, style, keywords, rating?, reviewsCount?
  }
```

**`extractStyleKeywords(text)`** scans for: cozy, romantic, elegant, modern, vibrant, minimal, rustic, luxury, dark, bright, fresh, botanical, industrial, casual, refined, warm.

### 6.3 Template Selection Prompts

**`buildTemplateSelectionSystemPrompt()`:**
- Iterates `RESTAURANT_THEMES` array
- Renders each theme as XML: `<template><name>, <description>, <cuisines>, <style>`
- Selection priority: cuisine > price tier > brand style > ambiance
- Required output: `<selection><templateName><reasoning><title>`

**`buildTemplateSelectionContextPrompt(profile)`:**
- Calls `analyzeBusinessProfile(profile)` to get structured analysis
- Formats as labeled text:
  ```
  Business Profile:
  - Name: {displayName || crawled_data.name}
  - Category: {analysis.category}
  - Cuisine: {analysis.cuisine}
  - Price Tier: {analysis.priceTier}
  - Style: {analysis.style}
  - Keywords: {analysis.keywords.join(', ')}
  - Tone: {brandStrategy.toneOfVoice}
  - Visual Style: {brandStrategy.visualStyle}
  - Rating: {rating} ({reviewsCount} reviews)     [if available]
  - Menu Categories: {first 8 names}               [if available]
  ```

**`parseTemplateSelection(llmOutput)`:**
- Regex extraction: `<templateName>`, `<reasoning>`, `<title>`
- Returns null if `<templateName>` not found (triggers fallback)

### 6.4 Content Prompt Composition (Phase 2 preprocessing)

**Function:** `composeContentPrompt(businessProfile, themePrompt)` → string

This is the main system prompt builder for the content generation LLM. It has **two paths** depending on whether markdown data is available:

#### Markdown Path (preferred, from PR #30)

When `businessProfile.google_maps_markdown` exists, the prompt uses pre-formatted markdown:

```
Input: BusinessProfile with google_maps_markdown + optional website_markdown
  |
  v
Output structure:
  ┌─────────────────────────────────────────────────────────────────┐
  │ <google_maps_data>                                              │
  │   {businessProfile.google_maps_markdown}                        │
  │ </google_maps_data>                                             │
  │                                                                 │
  │ <existing_website_analysis>        (if website_markdown exists) │
  │   {businessProfile.website_markdown}                            │
  │ </existing_website_analysis>                                    │
  │   Use existing website to match visual style and tone           │
  │                                                                 │
  │ Content requirements + task instructions                        │
  └─────────────────────────────────────────────────────────────────┘
```

**Note:** Theme prompt is NOT included in this path — it's injected separately in `stream-text.ts` via `restaurantThemeId` to avoid duplication.

#### Legacy Path (fallback)

When no markdown is available, falls back to structured formatting:

```
Input: BusinessProfile + themePrompt (from .md file)
  |
  v
Output structure (concatenated):
  ┌─────────────────────────────────────────────────────────────────┐
  │ THEME DESIGN INSTRUCTIONS:                                      │
  │   {themePrompt}                (loaded from app/theme-prompts/) │
  │                                                                 │
  │ BRAND VOICE:                                                    │
  │   {toneOfVoice line}           (if available)                   │
  │   {usp line}                   (if available)                   │
  │   {targetAudience line}        (if available)                   │
  │   {visualStyle line}           (if available)                   │
  │                                                                 │
  │ COLOR PALETTE (if provided):                                    │
  │   {formatColorPaletteForPrompt()}                               │
  │                                                                 │
  │ TYPOGRAPHY (if provided):                                       │
  │   {formatTypographyForPrompt()}                                 │
  │                                                                 │
  │ BUSINESS PROFILE (use EXACT values where provided):             │
  │   {formatBusinessDataForPrompt()}  ← MAIN DATA BLOCK           │
  │                                                                 │
  │ CONTENT REQUIREMENTS:                                           │
  │   1. MUST use exact business name in header, footer, meta       │
  │   2. MUST use exact address and phone in Contact section        │
  │   3. MUST use provided hours if available                       │
  │   4. MUST replace ALL placeholders (no lorem ipsum)             │
  │   5. MUST generate complete file contents (no TODOs)            │
  │   6. SHOULD incorporate USP into hero + about copy              │
  │   7. SHOULD apply color palette and typography                  │
  │                                                                 │
  │ TASK: Generate complete production-ready restaurant website     │
  │ Include: Hero, About, Menu, Contact, Footer                    │
  └─────────────────────────────────────────────────────────────────┘
```

### 6.5 `formatBusinessDataForPrompt(profile)` — Core Data Formatter

The most important data processing function. Converts `BusinessProfile` into a structured text block for LLM consumption.

**Source:** `projectGenerationService.ts:752-842`

```
Input: BusinessProfile { crawled_data, generated_content }
  |
  +--> Resolve fields with fallback defaults:
  |      displayName = generated_content.businessIdentity.displayName
  |                    || crawled_data.name
  |                    || "Restaurant Name"
  |      legalName   = generated_content.businessIdentity.legalName || ""
  |      tagline     = generated_content.businessIdentity.tagline || ""
  |      description = generated_content.businessIdentity.description || ""
  |      address     = crawled_data.address || "123 Main Street"
  |      phone       = crawled_data.phone || "(555) 123-4567"
  |      website     = crawled_data.website || generated_content.extractedData.websiteUrl || ""
  |
  +--> Hours formatting:
  |      If crawled_data.hours exists:
  |        Object.entries(hours).slice(0, 7).map(([day, value]) => "- {day}: {value}")
  |      Else: "- Contact us for hours"
  |
  +--> Track missing fields: name, address, phone, hours
  |
  +--> Delegate to sub-formatters:
  |      formatMenuForPrompt(crawled_data.menu)
  |      formatReviewsForPrompt(crawled_data.reviews)
  |      formatPhotosForPrompt(crawled_data.photos)
  |
  v
Output format (custom label+dash plain text):
  BASIC INFO:
  - Display Name: Pho Saigon
  - Legal Name: Pho Saigon LLC               [if available]
  - Tagline: Authentic Vietnamese Cuisine     [if available]
  - Description: Family-owned since 1995...   [if available]

  CONTACT:
  - Address: 123 Main St, Los Angeles, CA
  - Phone: (213) 555-1234
  - Website: https://phosaigon.com            [if available]

  HOURS:
  - Monday: 10am-9pm
  - Tuesday: 10am-9pm
  ...

  DEFAULTS USED (because data was missing): none
  (or: DEFAULTS USED: address="123 Main Street", phone="(555) 123-4567")

  MENU (if provided):
  {formatMenuForPrompt output}

  REVIEWS (if provided):
  {formatReviewsForPrompt output}

  PHOTOS (if provided):
  {formatPhotosForPrompt output}
```

### 6.6 Sub-Formatters

**`formatMenuForPrompt(menu)`** — `projectGenerationService.ts:844-865`
```
Input: Menu { categories: MenuCategory[] } | undefined
  |
  +--> undefined or empty --> "N/A"
  |
  +--> Take first 4 categories, first 6 items each:
  v
  - Appetizers
    - Spring Rolls ($8.99) — Fresh vegetables in rice paper
    - Pho Bo ($12.99) — Traditional beef noodle soup
  - Main Course
    - Grilled Chicken ($15.99)
    ...
```

**`formatReviewsForPrompt(reviews)`** — `projectGenerationService.ts:867-884`
```
Input: Review[] | undefined
  |
  +--> undefined or empty --> "N/A"
  |
  +--> Filter: non-empty text only
  +--> Sort: by rating DESC
  +--> Take first 5
  |
  v
  - "Best pho in the city!" — John D. (5/5)
  - "Great authentic flavors" — Jane S. (4/5)
  ...
```

**`formatPhotosForPrompt(photos)`** — `projectGenerationService.ts:886-897`
```
Input: Photo[] | undefined
  |
  +--> undefined or empty --> "N/A"
  |
  +--> Filter: valid non-empty URLs
  +--> Take first 6
  |
  v
  - https://lh3.google.../photo1.jpg
  - https://lh3.google.../photo2.jpg
  ...
```

**`formatColorPaletteForPrompt(palette)`** — `projectGenerationService.ts:899-917`
```
Input: ColorPalette | undefined
  |
  +--> undefined --> "N/A"
  |
  v
  - Primary: #1A1A2E (headers, CTAs, key elements)
  - Secondary: #16213E (accents, borders)
  - Accent: #E94560 (highlights)
  - Background: #F5F5F5, #FFFFFF
  - Text: #212121, #757575
```

**`formatTypographyForPrompt(typography)`** — `projectGenerationService.ts:919-935`
```
Input: Typography | undefined
  |
  +--> undefined --> "N/A"
  |
  v
  - Heading font: Playfair Display
  - Body font: Inter
  - All fonts: Playfair Display, Inter, Montserrat
```

### 6.7 File Extraction & Normalization (Phase 2 post-processing)

**`extractFileActionsFromBuffer(input)`** — `projectGenerationService.ts:1063-1119`

Incrementally parses `<boltAction type="file" filePath="...">` blocks from streaming LLM output.

```
Input: raw text buffer (from assistantMessage or LLM stream)
  |
  +--> Scan for <boltAction ... </boltAction> blocks
  |      Only process type="file" blocks
  |
  +--> For each complete block:
  |      1. Extract filePath from attribute: filePath="src/App.tsx"
  |      2. Extract raw content between opening tag '>' and '</boltAction>'
  |      3. normalizeFilePath(rawPath)
  |           - Strip [Model: ...] and [Provider: ...] markers
  |           - Prepend /home/project/ if not absolute
  |           - Collapse double slashes
  |      4. cleanBoltFileContent(rawContent, filePath)
  |           - Strip model/provider markers
  |           - Unwrap single markdown code fence (```lang\n...\n```)
  |           - Unescape XML entities (&lt; → <, &gt; → >)
  |           - Trim, add trailing newline (except .md files)
  |
  v
  Output: { files: GeneratedFile[], remaining: string }
    remaining = any partial <boltAction block not yet closed
```

### 6.8 FileMap Construction (Phase 3 post-processing)

**`buildFileMapFromGeneratedFiles(files)`** — `projectGenerationService.ts:1126-1181`

```
Input: GeneratedFile[] (template files + LLM files in order)
  |
  +--> For each file:
  |      1. normalizeFilePath(file.path) --> /home/project/src/App.tsx
  |      2. Track version history per path:
  |           - First 50 unique files tagged as "TEMPLATE"
  |           - Subsequent versions tagged as "LLM"
  |      3. Create folder entries for all parent directories
  |      4. Set map[fullPath] = { type: 'file', content, isBinary: false }
  |           (last write wins — LLM overwrites template)
  |
  +--> Log overwrites:
  |      [FILE_MAP] /home/project/src/App.tsx: 2 versions
  |        [TEMPLATE@3(4521) → LLM@67(6802)], winner=LLM
  |
  v
  Output: FileMap { [path]: { type: 'file' | 'folder', ... } }
    Final count logged: "{N} unique files from {M} total entries"
```

---

## 7. SSE Protocol & Events

**Response headers:**
```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive
```

**Event format:**
```
event: {eventName}
data: {JSON payload}

```

### Event types

| Event | Phase | Payload | When |
|-------|-------|---------|------|
| `progress` | All | `{ phase, status, message, percentage, startedAt, templateName? }` | Phase transitions |
| `template_selected` | 1 | `{ name, themeId, reasoning }` | After template selection |
| `file` | 2 | `{ path, content, size }` | Each generated file |
| `complete` | 3 | `{ success, projectId, template, files, snapshot, timing }` | Generation done |
| `error` | Any | `{ message, code, retryable }` | On failure |
| `heartbeat` | All | `{ timestamp }` | Every 5 seconds |

### Progress percentages

| Percentage | Phase | Message |
|------------|-------|---------|
| 10% | template_selection | "Analyzing business details" |
| 20% | template_selection (done) | "Template selected: {name}" |
| 30% | content_generation | "Generating layout & copy" |
| 80% | content_generation | "Final polish & SEO check" |
| 90% | snapshot_save | "Saving project" |

---

## 8. Alternative Flow: Chat-Based Generation

Users can also trigger generation through the chat interface instead of the onboarding wizard.

**Files:**
- Gate: `app/lib/hooks/useInfoCollectionGate.ts`
- Store: `app/lib/stores/infoCollection.ts`
- Chat: `app/components/chat/Chat.client.tsx`

```
User types "generate website for my restaurant" in chat
  |
  v
isWebsiteGenerationIntent(message)
  -- Keyword matching: "generate website", "create website", "build website", etc.
  |
  v
Check info collection status:
  GET /api/info-collection?active=true     --> Resume existing session
  GET /api/info-collection?status=completed --> Use completed session
  No session --> Create new (POST /api/info-collection)
  |
  v
Info Collection Flow (via chat tools):
  Step 1: website_url (optional)
  Step 2: google_maps_url (optional)
  Step 3: description (required)
  Step 4: review (confirmation)
  |
  v
completeSession() --> CrawlerDataPackage --> Crawler invocation
  |
  v
Server sends TemplateInjectionAnnotation via SSE data stream:
  {
    type: 'templateInjection',
    chatInjection: { assistantMessage, userMessage },
    generation: { templateName, themeId, title, reasoning, businessName }
  }
  |
  v
Client receives annotation:
  --> Truncates message history (saves tokens)
  --> Injects template files as assistant message
  --> Adds continuation prompt as user message
  --> Reloads chat to continue LLM generation
```

---

## 9. API Route Reference

### Crawler & Extraction

| Route | Method | Auth | Purpose | Input | Output |
|-------|--------|------|---------|-------|--------|
| `/api/crawler/search` | POST | Required | Search business by name+address | `{ business_name, address }` | `{ success, data: VerifiedRestaurantData }` |
| `/api/crawler/extract` | POST | Required | Extract business data + generate markdown | `{ session_id, google_maps_url?, business_name?, address?, website_url?, place_id? }` | `{ success, data: BusinessData, google_maps_markdown?, website_markdown?, has_website }` |
| `/api/crawler/generate` | POST | Required | Generate content from crawled data | `{ session_id }` | `{ success, session_id, data: GeneratedContent }` |
| `/api/info-collection` | GET | Required | List/get info collection sessions | Query: `active`, `status`, or `id` | `InfoCollectionSession[]` or single |
| `/api/info-collection` | POST | Required | Create info collection session | `{ chatId? }` | `InfoCollectionSession` |
| `/api/info-collection` | DELETE | Required | Delete session | ID in path | `{ success }` |

### Generation

| Route | Method | Auth | Purpose | Input | Output |
|-------|--------|------|---------|-------|--------|
| `/api/project/generate` | POST | Required | Generate website (SSE stream) | `{ projectId, model?, provider? }` | SSE: progress, file, complete events |
| `/api/site/generate` | POST | Required | Conversational generation | FormData: `message, tenantId, sessionId` | SSE: prompt, crawl.*, toast events |
| `/api/llmcall` | POST | Required | General LLM call | `{ system, message, model, provider }` | `{ text }` or text stream |

### Projects

| Route | Method | Auth | Purpose | Input | Output |
|-------|--------|------|---------|-------|--------|
| `/api/projects` | GET | Required | List projects | Query: `status, limit, offset` | `{ projects, total }` |
| `/api/projects` | POST | Required | Create project | `{ name, description?, gmaps_url?, businessProfile? }` | `Project` |
| `/api/projects/:id` | GET | Required | Get project details | - | `ProjectWithDetails` |
| `/api/projects/:id` | PATCH | Required | Update project | `{ name?, description?, status? }` | `Project` |
| `/api/projects/:id` | DELETE | Required | Delete project (cascade) | - | `{ success }` |
| `/api/projects/:id/snapshot` | POST | Required | Save snapshot | `{ files: FileMap }` | `{ updated_at }` |
| `/api/projects/:id/messages` | GET | Required | Get messages | - | `{ messages, total }` |
| `/api/projects/:id/messages/append` | POST | Required | Append messages | `{ messages[] }` | `{ saved_count }` |

---

## 10. Key Data Structures

### 10.1 CrawlRequest (multi-method input)

**File:** `app/types/crawler.ts`

```typescript
interface CrawlRequest {
  session_id: string;
  google_maps_url?: string;  // Method 1: Direct Maps URL
  business_name?: string;    // Method 2: Name + Address
  address?: string;          //           (both required)
  website_url?: string;      // Method 3: Website URL
  place_id?: string;         // From search verification
}
```

### 10.2 VerifiedRestaurantData (from search)

**File:** `app/types/crawler.ts`

```typescript
interface VerifiedRestaurantData {
  name: string;
  place_id: string;
  data_id: string;
  address: string;
  phone?: string;
  website?: string;
  coordinates?: {
    latitude: number;
    longitude: number;
    zoom?: number;
  };
}
```

### 10.3 BusinessProfile (stored on projects table)

**File:** `app/types/project.ts`

```typescript
interface BusinessProfile {
  session_id?: string;        // Crawler session ID
  gmaps_url?: string;         // Source Google Maps URL
  crawled_data?: BusinessData; // Raw extracted data
  generated_content?: GeneratedContent; // AI-enhanced content
  crawled_at?: string;        // ISO timestamp
  google_maps_markdown?: string;  // LLM-processed markdown profile (from /generate-google-maps-markdown)
  website_markdown?: string;      // Website analysis with visual descriptions (from /crawl-website-markdown)
}
```

### 10.4 BusinessData (from external crawler)

**File:** `app/types/crawler.ts`

```typescript
interface BusinessData {
  name?: string;
  address?: string;
  phone?: string;
  website?: string;
  rating?: number;
  reviews_count?: number;
  hours?: Record<string, string>;  // { "Monday": "9am-9pm", ... }
  reviews?: Review[];              // { author, text, rating, date }
  menu?: Menu;                     // { categories: [{ name, items }] }
  photos?: Photo[];                // { url, type? }
}
```

### 10.5 GeneratedContent (AI-enhanced from crawler)

**File:** `app/types/crawler.ts`

```typescript
interface GeneratedContent {
  brandStrategy: {
    usp: string;
    targetAudience: string;
    toneOfVoice: string;
    visualStyle: string;
  };
  visualAssets: {
    colorPalette: { primary, secondary, accent, background[], text[] };
    typography: { headingFont, bodyFont, allFonts? };
    logo?: { url, source, description? };
  };
  businessIdentity: {
    legalName?: string;
    displayName: string;
    tagline: string;
    description: string;
  };
  industryContext: {
    categories: string[];
    pricingTier?: string;
    operationalHighlights?: string[];
  };
  reputationData?: {
    reviewsCount: number;
    averageRating: number;
    trustBadges?: string[];
  };
  contentSections: { hero?, about?, products?, [key: string] };
  extractedData?: { allImages?, instagramPosts?, websiteUrl?, pagesAnalyzed? };
}
```

### 10.6 CrawlerOutput (production master map, from mock/info-collection)

**File:** `app/types/info-collection.ts`

```typescript
interface CrawlerOutput {
  business_intelligence: {
    core_identity:      { legal_name, brand_display_name, tagline_inferred };
    industry_context:   { primary_category, price_tier, catalog_type, operational_highlights };
    nap_logistics:      { full_address, phone_clickable, booking_action_url, service_area_text };
    social_ecosystem:   { facebook_url, instagram_url, whatsapp_number, linkedin_url, tiktok_url };
    reputation_snapshot: { total_reviews, average_rating, trust_badge_text };
  };
  brand_strategy: {
    inferred_usp, target_audience_persona, tone_of_voice, visual_style_prompt
  };
  visual_asset_strategy: {
    color_palette_extracted: { primary_hex, accent_hex, is_dark_mode_suitable };
    typography_vibe: 'Serif_Elegant' | 'Sans_Clean' | 'Display_Playful' | 'Monospace_Technical';
  };
}
```

### 10.7 Type Relationship Diagram

```
VerifiedRestaurantData            (from /search-restaurant)
  |-- name, place_id, address
  |
  v  (passed to /crawl as business_name + address + place_id)

BusinessData                      (from /crawl)
  |-- name, address, phone, website, rating
  |-- hours, reviews[], menu, photos[]
  |
  v  (stored in businessProfile.crawled_data)

BusinessProfile                   (stored on projects.business_profile JSONB)
  |-- crawled_data: BusinessData      (always present after onboarding)
  |-- generated_content: GeneratedContent  (optional, from /generate-website-content)
  |-- google_maps_markdown: string    (optional, from /generate-google-maps-markdown)
  |-- website_markdown: string        (optional, from /crawl-website-markdown)
  |
  v  (consumed by projectGenerationService.ts)
      |
      +--> analyzeBusinessProfile()       --> Phase 1: Template Selection
      |      inferPriceTier()
      |      inferStyle()
      |      extractStyleKeywords()
      |
      +--> composeContentPrompt()         --> Phase 2: System Prompt
      |      formatBusinessDataForPrompt()
      |      formatMenuForPrompt()
      |      formatReviewsForPrompt()
      |      formatPhotosForPrompt()
      |      formatColorPaletteForPrompt()
      |      formatTypographyForPrompt()
      |
      +--> extractFileActionsFromBuffer() --> Phase 2: File Extraction
      |      normalizeFilePath()
      |      cleanBoltFileContent()
      |
      +--> buildFileMapFromGeneratedFiles() --> Phase 3: Snapshot
             normalizeFilePath() per file
             dedup (last write wins)

CrawlerOutput                     (from mock crawler / info-collection)
  |
  v  (stored on info_collection_sessions.crawler_output)
  |
  +--> websiteGenerationService.ts  (transforms via contentTransformer)
```

### 10.8 Markdown Response Types (from PR #30)

**File:** `app/types/crawler.ts`

```typescript
interface GenerateGoogleMapsMarkdownResponse {
  success: boolean;
  markdown?: string;      // LLM-processed markdown profile
  error?: string;
  statusCode?: number;
}

interface CrawlWebsiteMarkdownRequest {
  url: string;                     // Website URL to crawl
  session_id: string;              // Links to prior /crawl
  max_pages?: number;              // Default: 1 (homepage)
  enable_visual_analysis?: boolean; // LLM Vision (default: true)
}

interface CrawlWebsiteMarkdownResponse {
  success: boolean;
  data?: {
    markdown: string;     // Markdown with visual style descriptions
    session_id: string;
    url: string;
  };
  error?: string;
  statusCode?: number;
}
```

### 10.9 GeneratedFile & FileMap

**File:** `app/types/generation.ts`, `app/lib/stores/files.ts`

```typescript
interface GeneratedFile {
  path: string;     // Normalized: /home/project/src/App.tsx
  content: string;  // Cleaned (unwrapped markdown, unescaped XML)
  size: number;     // Character count
}

type FileMap = {
  [path: string]:
    | { type: 'folder' }
    | { type: 'file'; content: string; isBinary: boolean }
}
```

---

## 11. Error Handling

### 11.1 Crawler Error Tiers

**Search route** (`api.crawler.search.ts`):

| Condition | HTTP Status | Error Code |
|-----------|-------------|------------|
| Unauthenticated | 401 | UNAUTHORIZED |
| Missing business_name | 400 | INVALID_INPUT |
| Missing address | 400 | INVALID_INPUT |
| Timeout | 408 | CRAWLER_TIMEOUT |
| Service unavailable | 503 | CRAWLER_UNAVAILABLE |
| Search failed | varies | SEARCH_FAILED |
| Unknown error | 500 | INTERNAL_SERVER_ERROR |

**Extract route** (`api.crawler.extract.ts`):

| Condition | HTTP Status | Error Code |
|-----------|-------------|------------|
| Unauthenticated | 401 | UNAUTHORIZED |
| No valid input method | 400 | INVALID_INPUT |
| Invalid URL hostname (sole method) | 400 | INVALID_INPUT |
| Timeout (5 min) | 408 | CRAWLER_TIMEOUT |
| Network error (ECONNREFUSED) | 502 | CRAWLER_UNAVAILABLE |
| Crawler 4xx response | 400 | CRAWLER_VALIDATION_ERROR |
| Crawler 5xx response | 502 | CRAWLER_SERVER_ERROR |
| Unknown error | 500 | CRAWLER_ERROR |

**Client level** (`crawlerClient.server.ts`):
- Adds `statusCode` to all error responses
- Parses error body for `error`, `message`, or `detail` fields
- Wraps network errors with descriptive messages
- Consistent pattern across `extractBusinessData()`, `generateWebsiteContent()`, `searchRestaurant()`, `generateGoogleMapsMarkdown()`, `crawlWebsiteMarkdown()`
- Markdown endpoints use shorter timeout (120s vs 300s for crawl)

**Agent level** (`crawlerAgent.server.ts`):
- Cross-tenant access prevention
- URL normalization failures
- Zod validation errors with formatted messages
- Structured errors with remediation guidance

### 11.2 Generation Error Codes

**File:** `app/types/generation.ts`

| Code | Meaning |
|------|---------|
| `PROJECT_NOT_FOUND` | Project doesn't exist or not owned by user |
| `NO_BUSINESS_PROFILE` | Missing required business data (at minimum: name) |
| `TEMPLATE_SELECTION_FAILED` | LLM selection failed (falls back to classicminimalistv2) |
| `GENERATION_FAILED` | Content generation error |
| `SNAPSHOT_SAVE_FAILED` | Database save error |
| `INTERNAL_ERROR` | Unexpected error |

### 11.3 Fallback Strategies

| Failure Point | Fallback |
|--------------|----------|
| No `business_profile` on project | Create minimal profile from `project.name` |
| Template selection LLM fails | Use `classicminimalistv2` (Classic Minimalist) |
| Local zip template missing | Fall back to GitHub fetch (`template-resolver.ts`) |
| GitHub template fetch fails | Fall back to from-scratch LLM generation |
| Snapshot save fails | Generation still completes; error reported in `complete` event |
| External crawler unavailable | Mock crawler with cuisine detection from description |
| Search API fails | User falls back to manual Maps URL entry |
| Google Maps markdown fails | Generation proceeds with structured `BusinessData` (legacy path) |
| Website markdown fails | Generation proceeds with Google Maps data only (graceful degradation) |
| No website URL found | Skip website markdown entirely; log info |

---

## 13. LLM Intelligence Pipeline

This section provides a comprehensive overview of how the LLM transforms business data (markdown or structured) into a customized restaurant website. It covers the theme prompt system, prompt composition, data processing, and streamText configuration.

### 13.1 Architecture Overview

```
BusinessProfile (input)
  |
  +--> HAS google_maps_markdown?
  |      |
  |      +--> YES (Markdown Path)
  |      |      composeContentPrompt() returns:
  |      |        <google_maps_data>{markdown}</google_maps_data>
  |      |        <existing_website_analysis>{website_markdown}</existing_website_analysis>
  |      |
  |      +--> NO (Legacy Path)
  |             composeContentPrompt() returns:
  |               THEME DESIGN INSTRUCTIONS: {themePrompt}
  |               BRAND VOICE: {tone, usp, audience, style}
  |               COLOR PALETTE: {formatColorPaletteForPrompt()}
  |               TYPOGRAPHY: {formatTypographyForPrompt()}
  |               BUSINESS PROFILE: {formatBusinessDataForPrompt()}
  |                 +--> formatMenuForPrompt()     (4 categories, 6 items each)
  |                 +--> formatReviewsForPrompt()  (5 top-rated reviews)
  |                 +--> formatPhotosForPrompt()   (6 image URLs)
  |               CONTENT REQUIREMENTS: (exact data usage rules)
  |
  v
Template Priming (buildTemplatePrimingMessages)
  |
  +--> assistantMessage: <boltArtifact> with all template files
  +--> userMessage: BUSINESS DATA + CUSTOMIZATION TASK
  |
  v
streamText() Call
  |
  +--> System prompt = base prompt (from PromptLibrary)
  |      + additionalSystemPrompt (composeContentPrompt output)
  |      + RESTAURANT THEME INSTRUCTIONS (if chatMode='build' && restaurantThemeId)
  |
  +--> Messages = [assistantMessage, userMessage]
  |
  +--> Model resolution: provider.getModelInstance({ model, apiKeys, ... })
  +--> Token limits: getCompletionTokenLimit(modelDetails)
  |
  v
LLM Response Stream --> extractFileActionsFromBuffer() --> GeneratedFile[]
```

### 13.2 Theme Prompt System

**Files:**
- Registry: `app/theme-prompts/registry.ts`
- Theme prompts: `app/theme-prompts/*.md` (12 files)
- Types: `app/types/restaurant-theme.ts`

#### Theme Registry Architecture

```typescript
// Themes loaded using Vite ?raw suffix at build time
import IndochineluxePrompt from './Indochineluxe.md?raw';

// Registry array with metadata + prompt content
export const RESTAURANT_THEMES: RestaurantTheme[] = [
  {
    id: 'indochineluxe',
    label: 'Indochine Luxe',
    description: 'Luxurious Southeast Asian dining...',
    cuisines: ['vietnamese', 'french-indochine', 'luxury', ...],
    styleTags: ['luxurious', 'colonial', 'silk', ...],
    templateName: 'Indochine Luxe',
    prompt: IndochineluxePrompt,  // Full .md content as string
  },
  // ... 11 more themes
];

// Lookup functions
getThemeById(id) → RestaurantTheme | undefined
getThemeByTemplateName(name) → RestaurantTheme | undefined
getThemePrompt(id) → string | null  // Returns the .md content
```

#### Theme Prompt Structure (.md files)

Each theme prompt file follows a consistent structure:

```markdown
# SYSTEM PROMPT: THE INDOCHINE LUXE (HIGH-END VIETNAMESE)

## 1. ROLE
You are a **Creative Director and Cultural Architect**...

## 2. OBJECTIVES
Generate a creative **Design System**, **Component Concepts**, and **Content Strategy**...

## 3. ARCHETYPE: THE INDOCHINE LUXE
**Concept:** A digital expression of "Modern Heritage."...

### Design Tokens (The "Skin")
- **Typography:** Display: Cinzel/Playfair Display, Body: Manrope/Inter
- **Texture:** Lacquer & Brass, Lotus/Lantern patterns
- **Color:** Jewel Tones - Charcoal (#1C1C1C), Antique Gold (#C5A059)
- **Imagery:** Moody Chiaroscuro, dramatic shadows
- **Buttons:** Gold/Brass Outlines, 2px corners

### Generalized Design Principles
- Visual Hierarchy, Navigation, Accessibility...

## 4. ABSTRACTED COMPONENT LIBRARY
- Module A: The Cinematic Heritage Hero
- Module B: The Signature Dish Spotlight
- Module C: The Ingredient Origin Grid
- Module D: The Ambience Gallery

## 5. CONTENT GENERATION SCHEMA
Instructions, Tone, Image Prompts, SEO, Data Structure...

## OUTPUT FORMAT - CRITICAL
<boltArtifact>/<boltAction> format requirements...
```

### 13.3 Theme Injection in streamText

**File:** `app/lib/.server/llm/stream-text.ts:190-218`

The theme prompt is injected into the system prompt only when:
1. `chatMode === 'build'` (not 'discuss')
2. `restaurantThemeId` is provided (non-null)

```typescript
// Theme injection logic
if (chatMode === 'build' && restaurantThemeId) {
  const themePrompt = getThemePrompt(restaurantThemeId);

  if (themePrompt) {
    systemPrompt = `${systemPrompt}

---
RESTAURANT THEME INSTRUCTIONS:
${themePrompt}
---
`;
  }
}
```

**Note:** In the markdown path, theme instructions are NOT included in `composeContentPrompt()` output because they're injected here. This avoids duplication.

### 13.4 Template Priming Mechanism

**File:** `app/lib/.server/templates/template-primer.ts`

Template priming injects the resolved template files into the conversation so the LLM customizes existing code rather than generating from scratch.

#### Message Construction

```
buildTemplatePrimingMessages(includedFiles, ignoredFiles, businessProfile, templateName, themePrompt, title)
  |
  +--> assistantMessage (buildTemplateFilesMessage):
  |      "Bolt is initializing your project with the {templateName} template."
  |      <boltArtifact id="imported-files" title="{title}" type="bundled">
  |        <boltAction type="file" filePath="src/App.tsx">
  |          {file.content}
  |        </boltAction>
  |        <boltAction type="file" filePath="src/data/content.ts">
  |          {file.content}
  |        </boltAction>
  |        ... (all template files)
  |      </boltArtifact>
  |
  +--> userMessage (buildCustomizationMessage):
         TEMPLATE INSTRUCTIONS:
           {themePrompt}
         ---
         STRICT FILE ACCESS RULES:
           Read-only files list (from ignoredFiles)
         ---
         BUSINESS DATA TO INJECT:
           {formatBusinessProfileForCustomization(profile)}
         ---
         CUSTOMIZATION TASK:
           Instructions to modify existing files, not generate new boilerplate
         ---
         OUTPUT FORMAT - FINAL REMINDER:
           <boltArtifact>/<boltAction> format requirements
```

#### Business Data Formatting for Priming

`formatBusinessProfileForCustomization(profile)` outputs:

```
Business Name: Pho Saigon
Tagline: Authentic Vietnamese Cuisine
Description: Family-owned since 1995...

Contact Information:
  Address: 123 Main St, Los Angeles, CA
  Phone: (213) 555-1234
  Website: https://phosaigon.com

Hours of Operation:
  Monday: 10am-9pm
  Tuesday: 10am-9pm
  ...

Menu:
  Appetizers:
    - Spring Rolls ($8.99)
    - Pho Bo ($12.99)
  Main Course:
    - Grilled Chicken ($15.99)
  ... (6 categories max, 6 items each)

Top Reviews:
  "Best pho in the city!" — John D. (5★)
  "Great authentic flavors" — Jane S. (4★)
  ... (3 reviews max)

Brand Tone: Warm and welcoming
Unique Selling Point: 24-hour slow-cooked broth
Target Audience: Food enthusiasts and families

Color Palette:
  Primary: #1A1A2E
  Secondary: #16213E
  Accent: #E94560
```

### 13.5 Image URL Handling

Image URLs from the crawler are passed directly to the LLM without modification. The LLM is instructed to use them in `<img>` tags.

#### Photo Processing Flow

```
crawled_data.photos[] (from /crawl response)
  |
  +--> Photo { url: string, type?: string }
  |
  +--> formatPhotosForPrompt() (6 URLs max)
  |      Output:
  |      - https://lh3.googleusercontent.com/.../photo1.jpg
  |      - https://lh3.googleusercontent.com/.../photo2.jpg
  |      - ...
  |
  +--> Injected into prompt:
         PHOTOS (if provided):
         - https://lh3.googleusercontent.com/.../photo1.jpg
         - ...

         Usage instructions (legacy path):
         "Include these photos in Hero, Gallery, or Menu sections"
```

**Important:** Photos are typically Google Maps or Google Business Profile URLs (lh3.googleusercontent.com). The LLM places these in:
- Hero background/gallery
- Menu item images
- About section imagery
- Gallery masonry grids

### 13.6 Text Content Processing

Text content flows through with light normalization:

| Data Field | Source | Processing | Usage in Prompt |
|------------|--------|------------|-----------------|
| Business name | `crawled_data.name` or `businessIdentity.displayName` | Trim, fallback to "Restaurant Name" | BASIC INFO: Display Name |
| Tagline | `businessIdentity.tagline` | Trim | BASIC INFO: Tagline |
| Description | `businessIdentity.description` | Trim | BASIC INFO: Description |
| Address | `crawled_data.address` | Trim, fallback to placeholder | CONTACT: Address |
| Phone | `crawled_data.phone` | Trim, fallback to placeholder | CONTACT: Phone |
| Hours | `crawled_data.hours` (Record) | Slice to 7 days, format "Day: Value" | HOURS section |

**Defaults tracking:** When data is missing, the prompt includes a "DEFAULTS USED" line so the LLM knows which values are placeholders.

### 13.7 Menu Data Processing

**Function:** `formatMenuForPrompt(menu)` — `projectGenerationService.ts:844-865`

```
Input: Menu { categories: MenuCategory[] }
  |
  +--> Limit: 4 categories max
  +--> Per category: 6 items max
  |
  v
Output format:
  - Appetizers
    - Spring Rolls ($8.99) — Fresh vegetables in rice paper
    - Pho Bo ($12.99) — Traditional beef noodle soup
  - Main Course
    - Grilled Chicken ($15.99)
```

**Processing rules:**
- Categories without items are skipped
- Item format: `{name} ({price}) — {description}`
- Price and description are optional
- Empty menu returns "N/A"

### 13.8 Reviews Processing

**Function:** `formatReviewsForPrompt(reviews)` — `projectGenerationService.ts:867-884`

```
Input: Review[] { author, rating, text, date }
  |
  +--> Filter: non-empty text only
  +--> Sort: rating DESC (highest first)
  +--> Limit: 5 reviews max
  |
  v
Output format:
  - "Best pho in the city!" — John D. (5/5)
  - "Great authentic flavors" — Jane S. (4/5)
```

**Processing rules:**
- Reviews without text are excluded
- Author shown if available
- Rating shown as X/5 format
- Empty reviews array returns "N/A"

### 13.9 streamText Configuration

**File:** `app/lib/.server/llm/stream-text.ts`

#### Model Resolution

```
1. Extract model/provider from last user message
   extractPropertiesFromMessage(message) → { model, provider, content }

2. Find provider in PROVIDER_LIST
   PROVIDER_LIST.find(p => p.name === currentProvider)

3. Get model details from static or dynamic models
   staticModels = LLMManager.getInstance().getStaticModelListFromProvider(provider)
   modelDetails = staticModels.find(m => m.name === currentModel)

4. If not found, fetch dynamic models
   modelsList = await LLMManager.getInstance().getModelListFromProvider(provider, { apiKeys, ... })
```

#### Token Limit Calculation

```typescript
function getCompletionTokenLimit(modelDetails): number {
  // Priority 1: Model-specific completion tokens
  if (modelDetails.maxCompletionTokens > 0) {
    return modelDetails.maxCompletionTokens;
  }

  // Priority 2: Provider-specific default
  const providerDefault = PROVIDER_COMPLETION_LIMITS[modelDetails.provider];
  if (providerDefault) {
    return providerDefault;
  }

  // Priority 3: Fallback (capped at 16384)
  return Math.min(MAX_TOKENS, 16384);
}
```

#### Reasoning Model Handling

For reasoning models (o1, GPT-5), different parameters are used:

```typescript
const isReasoning = isReasoningModel(modelDetails.name);

// Token parameter varies by model type
const tokenParams = isReasoning
  ? { maxCompletionTokens: safeMaxTokens }
  : { maxTokens: safeMaxTokens };

// Unsupported params filtered for reasoning models
// (temperature, topP, presencePenalty, frequencyPenalty, logprobs, etc.)
```

#### Final streamText Call

```typescript
const streamParams = {
  model: provider.getModelInstance({
    model: modelDetails.name,
    serverEnv,
    apiKeys,
    providerSettings,
  }),
  system: chatMode === 'build' ? systemPrompt : discussPrompt(),
  ...tokenParams,  // maxTokens or maxCompletionTokens
  messages: convertToCoreMessages(processedMessages),
  ...filteredOptions,
  ...(isReasoning ? { temperature: 1 } : {}),  // Required for reasoning models
};

return await _streamText(streamParams);
```

### 13.10 Complete Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        LLM INTELLIGENCE PIPELINE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  BusinessProfile                                                             │
│  ├── crawled_data (from /crawl)                                              │
│  │   ├── name, address, phone, website                                       │
│  │   ├── hours: Record<string, string>                                       │
│  │   ├── reviews: Review[]                                                   │
│  │   ├── menu: { categories: MenuCategory[] }                                │
│  │   └── photos: Photo[]                                                     │
│  ├── generated_content (from /generate-website-content)                      │
│  │   ├── brandStrategy: { usp, toneOfVoice, targetAudience, visualStyle }    │
│  │   ├── visualAssets: { colorPalette, typography, logo }                    │
│  │   └── businessIdentity: { displayName, tagline, description }             │
│  ├── google_maps_markdown (from /generate-google-maps-markdown)              │
│  └── website_markdown (from /crawl-website-markdown)                         │
│                                                                              │
│  ════════════════════════════════════════════════════════════════════════    │
│                                                                              │
│  PHASE 1: Template Selection                                                 │
│  ├── analyzeBusinessProfile() → { cuisine, priceTier, style, keywords }      │
│  ├── buildTemplateSelectionSystemPrompt() → 12 themes as XML                 │
│  ├── POST /api/llmcall (fast model)                                          │
│  └── parseTemplateSelection() → { themeId, name, reasoning }                 │
│                                                                              │
│  ════════════════════════════════════════════════════════════════════════    │
│                                                                              │
│  PHASE 2: Content Generation                                                 │
│  │                                                                           │
│  ├── Template Resolution                                                     │
│  │   └── resolveTemplate() → ResolvedTemplate { files[], source }            │
│  │                                                                           │
│  ├── Prompt Composition                                                      │
│  │   ├── MARKDOWN PATH (if google_maps_markdown exists):                     │
│  │   │   └── <google_maps_data> + <existing_website_analysis>                │
│  │   │                                                                       │
│  │   └── LEGACY PATH (fallback):                                             │
│  │       ├── Theme prompt (from .md file)                                    │
│  │       ├── formatColorPaletteForPrompt()                                   │
│  │       ├── formatTypographyForPrompt()                                     │
│  │       └── formatBusinessDataForPrompt()                                   │
│  │           ├── formatMenuForPrompt() → 4 categories × 6 items              │
│  │           ├── formatReviewsForPrompt() → 5 top reviews                    │
│  │           └── formatPhotosForPrompt() → 6 image URLs                      │
│  │                                                                           │
│  ├── Template Priming                                                        │
│  │   ├── buildTemplateFilesMessage() → <boltArtifact> with all files         │
│  │   └── buildCustomizationMessage() → BUSINESS DATA + TASK                  │
│  │                                                                           │
│  └── streamText() Call                                                       │
│      ├── System: base + additionalSystemPrompt + theme (if build mode)       │
│      ├── Messages: [assistantMessage, userMessage]                           │
│      ├── Model: provider.getModelInstance(...)                               │
│      └── Tokens: maxTokens or maxCompletionTokens                            │
│                                                                              │
│  ════════════════════════════════════════════════════════════════════════    │
│                                                                              │
│  OUTPUT PROCESSING                                                           │
│  ├── extractFileActionsFromBuffer() → GeneratedFile[]                        │
│  │   ├── normalizeFilePath() → /home/project/...                             │
│  │   └── cleanBoltFileContent() → unwrap markdown, unescape XML              │
│  └── buildFileMapFromGeneratedFiles() → FileMap (last write wins)            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File Index

All key files referenced in this document:

| Category | File Path |
|----------|-----------|
| **Routes** | |
| Onboarding | `app/routes/app.projects.new.tsx` |
| Onboarding UI | `app/components/projects/CreateProjectPage.tsx` |
| Post-login routing | `app/routes/_index.tsx`, `app/routes/app._index.tsx` |
| Crawler search | `app/routes/api.crawler.search.ts` |
| Crawler extract | `app/routes/api.crawler.extract.ts` |
| Crawler generate | `app/routes/api.crawler.generate.ts` |
| Project generate | `app/routes/api.project.generate.ts` |
| Site generate | `app/routes/api.site.generate.ts` |
| Info collection | `app/routes/api.info-collection.ts` |
| Projects CRUD | `app/routes/api.projects.ts`, `app/routes/api.projects.$id.ts` |
| LLM call | `app/routes/api.llmcall.ts` |
| **Services** | |
| Generation pipeline | `app/lib/services/projectGenerationService.ts` |
| Legacy generation | `app/lib/services/websiteGenerationService.ts` |
| Content transformer | `app/lib/services/contentTransformer.ts` |
| Crawler HTTP client | `app/lib/services/crawlerClient.server.ts` |
| Mock crawler | `app/lib/services/crawlerService.ts` |
| Crawler agent | `app/lib/services/crawlerAgent.server.ts` |
| Places client | `app/lib/services/internalPlacesClient.server.ts` |
| Info collection DB | `app/lib/services/infoCollectionService.server.ts` |
| Projects DB | `app/lib/services/projects.server.ts` |
| SSE utilities | `app/lib/services/sseUtils.ts` |
| Fast model resolver | `app/lib/services/fastModelResolver.ts` |
| **LLM & Templates** | |
| Stream text | `app/lib/.server/llm/stream-text.ts` |
| LLM constants | `app/lib/.server/llm/constants.ts` |
| LLM utils | `app/lib/.server/llm/utils.ts` |
| Template resolver | `app/lib/.server/templates/template-resolver.ts` |
| Zip template fetcher | `app/lib/.server/templates/zip-template-fetcher.ts` |
| GitHub template fetcher | `app/lib/.server/templates/github-template-fetcher.ts` |
| Template primer | `app/lib/.server/templates/template-primer.ts` |
| Theme registry | `app/theme-prompts/registry.ts` |
| Theme prompts | `app/theme-prompts/*.md` (12 files) |
| LLM Manager | `app/lib/modules/llm/manager.ts` |
| Prompt Library | `app/lib/common/prompt-library.ts` |
| **Telemetry** | |
| Langfuse | `app/lib/.server/telemetry/langfuse.server.ts` |
| **Types** | |
| Project | `app/types/project.ts` |
| Crawler | `app/types/crawler.ts` |
| Info collection | `app/types/info-collection.ts` |
| Generation | `app/types/generation.ts` |
| Template | `app/types/template.ts` |
| Restaurant theme | `app/types/restaurant-theme.ts` |
| **Stores** | |
| Auth | `app/lib/stores/auth.ts` |
| Info collection | `app/lib/stores/infoCollection.ts` |
| Workbench | `app/lib/stores/workbench.ts` |
| Files | `app/lib/stores/files.ts` |

---

## 12. Observability (Langfuse)

**File:** `app/lib/.server/telemetry/langfuse.server.ts`

Langfuse provides LLM call tracing and observability. It is feature-flagged and gracefully degrades when disabled.

### 12.1 Configuration

| Env Var | Required | Default | Purpose |
|---------|----------|---------|---------|
| `LANGFUSE_ENABLED` | No | `false` | Master toggle |
| `LANGFUSE_PUBLIC_KEY` | If enabled | - | Langfuse public key |
| `LANGFUSE_SECRET_KEY` | If enabled | - | Langfuse secret key |
| `LANGFUSE_BASE_URL` | No | `https://cloud.langfuse.com` | Self-hosted URL |

### 12.2 Architecture

```
Singleton client: getLangfuseClient(env?)
  |
  +--> isLangfuseEnabled(env) checks LANGFUSE_ENABLED + credentials
  +--> Graceful fallback: returns null if disabled/misconfigured
  +--> Environment detection: uses Cloudflare env or process.env fallback
  |
  v
Tracing API:
  createTrace(env, { name, userId, sessionId, metadata, input })
    --> LangfuseTraceContext { traceId, userId?, sessionId? }
  |
  createGeneration(env, traceContext, { name, model, input })
    --> { generationId, end(metadata) }
    --> end() records: output, token usage, provider, finishReason
  |
  flushTraces(env)
    --> client.flushAsync() -- call with ctx.waitUntil() on Cloudflare edge
```

### 12.3 Integration Points

The generation pipeline (`projectGenerationService.ts`) creates Langfuse traces at:

- **Template selection** (Phase 1): Traces the fast LLM call for template matching
- **Content generation** (Phase 2): Traces the main LLM streaming call

Each generation span records model, provider, token usage, latency, and finish reason.
