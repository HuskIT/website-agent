# V2 Plan: Mastra + E2B Incremental MVP

## Goal

Ship V2 quickly with:
- Fully autonomous first website creation from business name + address
- Mastra + E2B sandbox/preview core (replace Vercel sandbox path for V2)
- Ultra-simple UX for non-technical users (single prompt bar + full preview)
- `write_file` first for reliability, easy path to `edit_file` later

## Architecture Decision (Repo Strategy)

Build V2 inside the current repo, not a separate repo for Phase 1.

Why this is the fastest reliable path:
- We can reuse existing crawler and project persistence immediately.
- We keep V1 running while V2 is behind feature flags and V2 routes.
- We avoid duplicate infra/auth/deploy setup overhead.
- We can incrementally replace the unstable core (sandbox + generation) without big-bang migration risk.

Boundary rule:
- V1 path stays untouched.
- V2 path lives in `api.v2.*` + `app/lib/v2/*` + `app/lib/mastra/*`.

## V2 Reference Architecture (Huskit-Aligned, Autonomy-First)

- Layer 1 Experience:
  - `input (name + address) -> waiting insights -> preview + single prompt bar`
  - No plan approval UI in MVP (non-technical users).
- Layer 2 Orchestration:
  - V2 SSE routes orchestrate state transitions and stream deterministic events.
- Layer 3 Agent Core (Mastra):
  - `bootstrapWebsite` workflow for first full site generation.
  - `editWebsite` workflow for prompt-based updates after preview.
  - `write_file` mutation strategy first; `edit_file` added after reliability gate.
- Layer 4 Runtime:
  - E2B sandbox lifecycle + command execution + preview URL.
- Layer 5 Data:
  - Reuse `projects.business_profile`, `project_snapshots.files`.
  - Add V2 session metadata fields only if needed, no schema explosion in MVP.
- Layer 6 Reliability:
  - bounded build/fix loop
  - explicit SSE milestone events
  - feature flags for safe rollout

## Current Repo Data Flow Research (As-Is)

### Flow A: Current "Create Project" path (closest to V2 target)

1. `/app/projects/new` (`app/components/projects/CreateProjectPage.tsx`) collects `businessName + businessAddress`.
2. Calls `/api/crawler/search` (`app/routes/api.crawler.search.ts`) with:
   - `business_name`
   - `address`
3. Calls `/api/crawler/extract` (`app/routes/api.crawler.extract.ts`) with one crawl method (priority enforced in route):
   - `google_maps_url`
   - or `place_id + business_name + address`
   - or `business_name + address`
   - or `website_url`
4. Extract returns markdown payload:
   - `place_id`
   - `google_maps_markdown`
   - `website_markdown` (best effort)
5. Calls `/api/projects` (`app/routes/api.projects.ts`) and stores `businessProfile`.
6. Starts SSE `/api/project/generate` (`app/routes/api.project.generate.ts`).
7. `generateProjectWebsite` (`app/lib/services/projectGenerationService.ts`) streams:
   - `progress`
   - `template_selected`
   - `file`
   - `complete`
8. UI injects files into workbench and navigates to `/chat/:id`.

### Flow B: Chat info-collection path (parallel system)

1. `/api/chat` (`app/routes/api.chat.ts`) enables info-collection tools.
2. Tools (`app/lib/tools/infoCollectionTools.ts`) persist to `info_collection_sessions`.
3. `finalizeCollection` triggers `generateWebsite` (`app/lib/services/websiteGenerationService.ts`).
4. Result is stored as `pending_generation`, then re-streamed as `templateInjection`.

### Flow C: Legacy conversational crawler path

- `/api/site/generate` (`app/routes/api.site.generate.ts`) runs a separate conversational state machine + crawler SSE flow.
- This is an additional legacy path and should not be expanded for V2.

### Flow D: Current sandbox/preview path

1. Workbench chooses provider via `app/lib/sandbox/index.ts`.
2. Provider stack is `webcontainer` or `vercel` (`app/lib/sandbox/providers/*`).
3. Vercel runtime APIs:
   - `/api/sandbox/create`
   - `/api/sandbox/files`
   - `/api/sandbox/command`
   - `/api/sandbox/reconnect`
   - `/api/sandbox/status`
   - `/api/sandbox/extend`
   - `/api/sandbox/stop`
   - `/api/sandbox/snapshot*`
4. Project runtime refs:
   - `sandbox_id`
   - `sandbox_provider`
   - `sandbox_expires_at`

### Key As-Is Findings for V2

- Generation logic is split across multiple flows (A/B/C) and needs a single V2 path.
- Flow A already matches desired onboarding input and should be the V2 base.
- Current sandbox path is Vercel/WebContainer-specific and is the primary replacement target.
- Existing persistence contracts are good enough to start V2 without full DB redesign.

## MVP Reuse vs Replace

### Reuse in V2

- Crawler endpoints: `api.crawler.search`, `api.crawler.extract`
- Project persistence: `projects`, `project_snapshots`
- Type contracts from:
  - `app/types/project.ts`
  - `app/types/crawler.ts`
  - `app/types/generation.ts`
- Existing business onboarding UX patterns from `CreateProjectPage.tsx`

### Replace in V2

- `/api/project/generate` with Mastra-based V2 bootstrap route
- Vercel/WebContainer preview lifecycle with E2B V2 runtime path
- Post-bootstrap editing backend with Mastra `editWebsite`

### Keep Isolated (V1 Only)

- `/api/chat` info-collection generation pipeline
- `/api/site/generate` conversational crawler flow
- Existing Vercel sandbox provider/runtime stack

## Target V2 Data Flow (To-Be)

1. User inputs `business name + address`.
2. V2 bootstrap route runs `search -> extract` via adapter.
3. Project record is created/updated with normalized `business_profile`.
4. Mastra `bootstrapWebsite` workflow runs in E2B with `write_file`.
5. Workflow runs bounded loop: write files -> install/build -> fix -> start preview.
6. V2 route streams milestones + waiting-screen insights.
7. On completion, preview URL + snapshot metadata are returned and persisted.
8. User edits through single prompt bar; V2 `editWebsite` reuses same runtime session where possible.

## Working Mode

Build like a tree:
- small vertical slices
- one testable slice at a time
- no broad refactor before each slice is proven

V1 remains live while V2 is feature-flagged.

## Current Constraints (Local Terminal)

- Default shell Node path is still `v14.17.3` (`/usr/local/bin/node`), which cannot run project `pnpm` commands.
- Node `v24.11.1` is available at `~/.nvm/versions/node/v24.11.1/bin/node` and is used for all V2 verification commands.
- Repo requires Node `>=18.18.0`.
- Mastra packages are installed:
  - `@mastra/core@1.5.0`
  - `@mastra/e2b@0.0.3`
  - `@mastra/memory@1.4.0`
- Until shell profile is normalized, verification commands must run with PATH override to Node 24.

## Branch

- Active branch: `codex/v2-mastra-e2b-plan`

## Incremental Steps (Updated Plan)

### Step -1: Environment and dependency gate

**Deliver**
- Switch local Node to `>=18.18.0`.
- Install dependencies.
- Add Mastra/E2B packages with locked versions and basic config docs.

**Verify**
- `node -v`
- `pnpm install`
- `pnpm run typecheck`

**Done when**
- Repo builds/tests can run and Mastra imports resolve.

---

### Step 0: Freeze V2 route contracts and feature flags

**Deliver**
- Add `V2_MASTRA_ENABLED` and `V2_WAITING_INSIGHTS_ENABLED` (default off).
- Add V2 Zod contracts for:
  - bootstrap request (maps current crawler/business profile payloads)
  - bootstrap SSE events
  - edit request/response

**Verify**
- `pnpm exec vitest run tests/unit/routes/api.site.generate.test.ts`
- Add and run: `pnpm exec vitest run tests/unit/v2/contracts.test.ts`
- `pnpm run typecheck`

**Done when**
- V2 contracts compile and map to existing Flow A payload shape without behavior changes.

---

### Step 1: Build Flow-A adapter layer (no Mastra yet)

**Deliver**
- Add `app/lib/services/v2/bootstrapInputAdapter.ts` to normalize:
  - search result
  - extract markdown payload
  - project `business_profile`
- Add `app/lib/services/v2/bootstrapOutputAdapter.ts` for unified V2 output shape.

**Verify**
- Add and run: `pnpm exec vitest run tests/unit/services/v2/bootstrapInputAdapter.test.ts`
- Add and run: `pnpm exec vitest run tests/unit/services/v2/bootstrapOutputAdapter.test.ts`

**Done when**
- V2 data mapping is stable and independent of legacy route internals.

---

### Step 2: Mastra module skeleton + mutation strategy

**Deliver**
- Add:
  - `app/lib/mastra/factory.server.ts`
  - `app/lib/mastra/workflows/bootstrapWebsite.ts`
  - `app/lib/mastra/workflows/editWebsite.ts`
  - `app/lib/mastra/strategies/fileMutation.ts`
- Implement `WriteFileStrategy` as default.

**Verify**
- Add and run: `pnpm exec vitest run tests/unit/mastra/fileMutationStrategy.test.ts`
- `pnpm run typecheck`

**Done when**
- Mastra core compiles and uses `write_file` strategy by default.

---

### Step 3: E2B connectivity probe (isolated)

**Deliver**
- Add route: `app/routes/api.v2.sandbox.health.ts`.
- Probe:
  - create E2B session
  - run `node --version`
  - return structured health result

**Verify**
- Add and run: `pnpm exec vitest run tests/unit/routes/api.v2.sandbox.health.test.ts`
- Manual: `POST /api/v2/sandbox/health` returns `{ ok: true }` with valid credentials.

**Done when**
- E2B is validated independently of generation flow.

---

### Step 4: V2 bootstrap SSE route (stub, contract-first)

**Deliver**
- Add `app/routes/api.v2.site.bootstrap.ts`.
- Stream deterministic milestones:
  - `input_validated`
  - `crawler_started`
  - `generation_started`
  - `preview_starting`
  - `completed`

**Verify**
- Add and run: `pnpm exec vitest run tests/integration/api.v2.site.bootstrap.stream.test.ts`

**Done when**
- Frontend can integrate V2 SSE before full generation internals are wired.

---

### Step 5: Connect real crawler/search to V2 bootstrap

**Deliver**
- Reuse current `/api/crawler/search` and `/api/crawler/extract` via adapter layer.
- Support both:
  - business name + address
  - explicit maps URL fallback

**Verify**
- Add and run: `pnpm exec vitest run tests/integration/api.v2.site.bootstrap.crawler.test.ts`

**Done when**
- V2 bootstrap receives real markdown payload from existing crawler stack.

---

### Step 5.5: Database preflight gate (before any V2 execution)

**Deliver**
- Add `app/lib/services/v2/databasePreflight.server.ts`.
- Add route: `app/routes/api.v2.database.health.ts`.
- Add script: `pnpm run v2:db:health`.
- Gate `app/routes/api.v2.site.bootstrap.ts` with DB preflight before crawler/generation starts.

**Verify**
- Add and run: `pnpm exec vitest run tests/unit/services/v2/databasePreflight.server.test.ts`
- Add and run: `pnpm exec vitest run tests/unit/routes/api.v2.database.health.test.ts`
- Update and run: `pnpm exec vitest run tests/integration/api.v2.site.bootstrap.stream.test.ts`
- Manual: `pnpm run v2:db:health`

**Done when**
- V2 bootstrap returns clear `DATABASE_NOT_READY` errors when DB setup is missing/broken.
- DB checks are directly verifiable before executing Step 6 workflow logic.

---

### Step 6: Real Mastra Coding Agent (`bootstrapWebsite`, write-file first)

**Ground Truth (validated in repo)**
- Mastra packages are installed and importable from `node_modules/@mastra/*`.
- Mastra workflow API is validated against installed typings (vNext shape only):
  - `createWorkflow(...).then(createStep(...)).commit()`
  - `workflow.createRun()` + `run.start(...)` / `run.startAsync(...)`
- Current behavior to preserve comes from:
  - `app/routes/api.project.generate.ts`
  - `app/lib/services/projectGenerationService.ts`
  - `app/lib/.server/llm/stream-text.ts`
  - `app/lib/.server/templates/template-primer.ts`
  - `app/lib/services/contentGenerationValidator.ts`
- Current stable model target is `Moonshot + kimi-for-coding`:
  - `app/utils/defaults.ts`
  - `app/lib/modules/llm/providers/moonshot.ts`
  - `.env.example`
- Reference direction for Step 6 implementation:
  - `next-v/huskit-agent-blueprint.md` (workspace-centered runtime, write_file-first reliability)
  - `next-v/mastra-deep-dive.md` (bounded fix loops, search/read-before-write safety, memory staged later)

**Step 6.0: Dependency + API freeze (Mastra vNext only)**
- Add and lock Mastra dependencies.
- Freeze implementation to Workflows vNext API shape only:
  - `createWorkflow(...).then(createStep(...)).commit()`
  - run via `workflow.createRun()` + `run.start(...)` (or `run.startAsync(...)`)
- No legacy workflow API mixing.
- Status: `Completed (2026-02-23)`

**Verify**
- `pnpm run typecheck` (pass, Node 24 PATH override)
- `pnpm exec vitest run tests/unit/mastra/workflowCompile.test.ts` (pass)

**Done when**
- Mastra imports resolve and minimal vNext workflow compiles in tests.

---

**Step 6.1: Prompt Pack extraction (behavior parity with current /generate)**
- Extract reusable prompt pack builders from current generation service:
  - template selection prompt/context
  - content prompt composition (markdown-first path)
  - theme injection compatibility with stream layer behavior
- Keep output behavior unchanged from current generation path.
- Status: `Completed (slice 1, 2026-02-23)`
  - Added `app/lib/services/v2/promptPack.ts`
  - Rewired `app/lib/services/projectGenerationService.ts` to use extracted prompt pack

**Verify**
- `pnpm exec vitest run tests/unit/services/v2/promptPack.test.ts` (pass)
- `pnpm exec vitest run tests/snapshots/v2/promptPack.snapshot.test.ts -u` (pass, 4 snapshots written)
- `pnpm run typecheck` (pass)

**Done when**
- Prompt builders match current flow behavior with deterministic tests.

---

**Step 6.2: E2B runtime adapter + Workspace runtime**
- Implement V2 runtime adapter for workflow steps:
  - create sandbox/session
  - write files
  - run commands
  - start preview
  - cleanup/pause
- Add workspace-centered abstraction for short/long-term agent needs:
  - filesystem tools
  - command tools
  - search/read helpers
  - E2B-backed sandbox wiring
- Keep `write_file` as default mutation policy.
- Status: `Completed (slice 1, 2026-02-23)`
  - Added `app/lib/mastra/runtime/workspaceFactory.server.ts`
  - Added `app/lib/mastra/runtime/e2bRuntimeAdapter.server.ts`
  - Added `tests/unit/mastra/workspaceFactory.test.ts`
  - Added `tests/unit/mastra/e2bRuntimeAdapter.test.ts`

**Verify**
- Add and run: `pnpm exec vitest run tests/unit/mastra/e2bRuntimeAdapter.test.ts`
- Add and run: `pnpm exec vitest run tests/unit/mastra/workspaceFactory.test.ts`
- Manual: `pnpm run v2:sandbox:health`

**Done when**
- Workflow steps can reliably execute real sandbox actions through one adapter.

---

**Step 6.3: Implement real `bootstrapWebsite` workflow**
- Implement workflow stages:
  1. `prepare_context`
  2. `select_template`
  3. `load_template_files`
  4. `generate_content_file`
  5. `write_files_to_e2b`
  6. `install_and_build`
  7. `start_preview`
  8. `collect_artifacts`
- Add bounded build/fix loop (max retry attempts).
- Keep planner internal only (no user approval step).
- Status: `Completed (slice 2, 2026-02-23)`
  - `app/lib/mastra/workflows/bootstrapWebsite.ts` now executes via Mastra vNext workflow runtime (`createWorkflow -> createStep -> createRun`).
  - Added staged flow: `prepare_context`, `select_template`, `load_template_and_generate_content`, `write_files_to_e2b`, `install_and_build`, `start_preview`, `collect_artifacts`.
  - Added bounded build retry handling with cleanup-on-failure.
  - Existing mutation-only write-file behavior remains compatible for current tests/scripts.
  - Verified in:
    - `tests/unit/mastra/fileMutationStrategy.test.ts`
    - `tests/integration/v2/bootstrapWorkflow.writefile.test.ts`

**Verify**
- Add and run: `pnpm exec vitest run tests/integration/v2/bootstrapWorkflow.writefile.test.ts`
- Assert:
  - files are produced
  - build is attempted
  - preview start is attempted
  - retry loop is bounded

**Done when**
- First draft generation is autonomous and reproducible with deterministic retry behavior.

---

**Step 6.4: Wire workflow into V2 bootstrap SSE route**
- Integrate real workflow run in:
  - `app/routes/api.v2.site.bootstrap.ts`
- Preserve existing SSE milestone contract for frontend:
  - `input_validated`
  - `crawler_started`
  - `generation_started`
  - `preview_starting`
  - `completed`
  - `error`
- Status: `Completed (2026-02-23)`
  - Route now runs real `mastraCore.bootstrapWebsite.run(...)` after crawler resolution.
  - Maintains deterministic SSE milestones for both autonomous and seed/mutation fallback modes.
  - Added type-safe business profile normalization (`BusinessData`/`BusinessProfile`) before workflow input.
  - Hardened stream/crawler integration tests to avoid local env key leakage in test mode.

**Verify**
- Update and run: `pnpm exec vitest run tests/integration/api.v2.site.bootstrap.stream.test.ts`
- Update and run: `pnpm exec vitest run tests/integration/api.v2.site.bootstrap.crawler.test.ts`
- Regression set:
  - `pnpm exec vitest run tests/integration/v2/bootstrapWorkflow.writefile.test.ts`
  - `pnpm exec vitest run tests/unit/mastra/fileMutationStrategy.test.ts`
  - `pnpm exec vitest run tests/unit/mastra/workspaceFactory.test.ts`
  - `pnpm exec vitest run tests/unit/mastra/e2bRuntimeAdapter.test.ts`
  - `pnpm exec vitest run tests/unit/mastra/workflowCompile.test.ts`

**Done when**
- Frontend receives stable milestones while backend uses real workflow execution.

---

**Step 6.5: Real acceptance smoke (crawler + mastra + e2b + preview)**
- Add real Step 6 smoke command/script for end-to-end verification.
- Validate:
  - real crawler data consumed
  - real E2B commands run
  - preview URL returned
  - generated files non-empty
- Status: `Completed (2026-02-23)`
  - Added script: `scripts/v2-step6-real-test.ts`
  - Added command: `pnpm run v2:test:step6:real`
  - Verified with real run (crawler + E2B):
    - `extractMethod`: `verified_place`
    - `filesWritten`: `4`
    - `buildAttempts`: `1`
    - `previewUrl`: returned (E2B host)
    - markdown lengths: non-zero for both Google Maps and website

**Verify**
- Add and run: `pnpm run v2:test:step6:real`

**Done when**
- Step 6 is verifiable in one real command before moving to edit flow.

---

### Step 7: Persist runtime/workspace metadata + memory wiring

**Deliver**
- Persist V2 runtime metadata on project/session records:
  - sandbox/session id
  - preview URL
  - lifecycle state
- Add project-scoped workspace session reuse strategy.
- Add memory wiring (feature-flagged):
  - resource scope = business/project
  - thread scope = generation/edit session
- Add rollout flags:
  - `V2_WORKSPACE_ENABLED`
  - `V2_MEMORY_ENABLED`

**Verify**
- Add and run: `pnpm exec vitest run tests/integration/v2/previewPersistence.test.ts`
- Add and run: `pnpm exec vitest run tests/integration/v2/workspaceSessionReuse.test.ts`
- Add and run: `pnpm exec vitest run tests/unit/services/v2/memoryWiring.test.ts`

**Done when**
- Preview/session continuity is reliable and memory hooks are ready for iterative edits.

---

### Step 8: Waiting-screen insights slice

**Deliver**
- Add `app/lib/services/v2/waitingInsights.service.ts`.
- Start with deterministic facts from crawler markdown.
- Add optional LLM enrichment behind flag.

**Verify**
- Add and run: `pnpm exec vitest run tests/unit/services/waitingInsights.service.test.ts`

**Done when**
- Waiting screen adds value even when enrichment LLM is disabled.

---

### Step 9: Lean V2 UI shell (Canva-simple)

**Deliver**
- New V2 route/UI flow:
  - input: name + address
  - waiting insights screen
  - full preview + single prompt bar
- No plan approval UI in MVP.

**Verify**
- Add and run: `pnpm exec vitest run tests/unit/components/v2/v2FlowState.test.ts`
- Add Playwright smoke once stable.

**Done when**
- Non-technical users can generate and edit from one simple interface.

---

### Step 10: V2 edit route on shared strategy abstraction

**Deliver**
- Add `app/routes/api.v2.site.edit.ts`.
- Reuse Mastra core and `WriteFileStrategy`.

**Verify**
- Add and run: `pnpm exec vitest run tests/integration/api.v2.site.edit.test.ts`

**Done when**
- Prompt edits run on same V2 backend/runtime reliably.

---

### Step 11: `edit_file` migration (post-MVP optimization)

**Deliver**
- Add `EditFileStrategy`.
- Feature flag: `V2_EDIT_FILE_ENABLED`.
- Keep automatic fallback to `write_file` on failed/ambiguous edits.

**Verify**
- Add and run: `pnpm exec vitest run tests/unit/mastra/editFileFallback.test.ts`

**Done when**
- Token optimization is enabled without reducing reliability.

## Immediate Next Execution

1. Step 7: persist runtime/workspace metadata from V2 bootstrap runs (sandbox/session/preview state).
2. Add project-scoped workspace session reuse wiring with feature flag gates.
3. Add memory scaffolding behind `V2_MEMORY_ENABLED` without changing current user flow.
4. Stop for your review before implementing waiting-screen insights (Step 8).
