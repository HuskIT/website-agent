# Tasks: Multi-Sandbox Provider Support

**Input**: Design documents from `/specs/001-sandbox-providers/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/
**Last Updated**: 2026-02-05

**Tests**: Tests are NOT explicitly requested in the specification. Test tasks are omitted.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Implementation Summary

| Phase | Completed | Total | Status |
|-------|-----------|-------|--------|
| Phase 1: Setup | 4 | 4 | ✅ 100% |
| Phase 2: Foundational | 6 | 6 | ✅ 100% |
| Phase 3: US1 Fast Preview | 10 | 10 | ✅ 100% |
| Phase 4: US2 Session Persistence | 10 | 10 | ✅ 100% |
| Phase 5: US3 Provider Config | 6 | 6 | ✅ 100% |
| Phase 6: US4 Resource Usage | 3 | 3 | ✅ 100% |
| Phase 7: US5 Snapshots | 5 | 7 | 🟡 71% (see notes) |
| Phase 8: Polish | 5 | 6 | 🟡 83% (T048 skipped) |
| **Total** | **49** | **52** | **~94%** |

### Phase 7 Notes (Snapshots)
- **T040-T043**: Routes and provider methods exist but return **placeholder responses**
- Vercel Sandbox SDK doesn't have native snapshot support yet
- **T045 COMPLETED**: Auto-snapshot on warning (2 min before timeout) and on timeout - saves to database snapshot
- T044 and T046 remain unimplemented pending Vercel SDK snapshot feature

### Phase 8 Notes (Polish)
- **T048 Skipped**: Sandbox routes don't use `withSecurity` rate limiting pattern
- Rate limiting is acceptable to defer for MVP; can be added later

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## User Story Mapping

| Story | Title | Priority | Independent Test |
|-------|-------|----------|------------------|
| US1 | Fast Preview Updates | P1 | Modify file → preview updates within 5s |
| US2 | Session Persistence | P1 | Refresh browser → workspace restores in 3s |
| US3 | Provider Selection | P2 | Select provider in settings → next project uses it |
| US4 | Reduced Local Resources | P2 | Cloud provider → CPU <30% during build |
| US5 | Snapshot-Based Fast Starts | P3 | Reopen project with snapshot → ready in <10s |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, dependencies, and database schema

- [x] T001 Create sandbox module directory structure at app/lib/sandbox/
- [x] T002 Install @vercel/sandbox dependency via pnpm add @vercel/sandbox
- [x] T003 [P] Create database migration for sandbox columns in supabase/migrations/20260204223702_add_sandbox_columns.sql
- [x] T004 [P] Add environment variables to .env.example for VERCEL_TEAM_ID, VERCEL_PROJECT_ID, VERCEL_TOKEN, SANDBOX_PROVIDER_DEFAULT

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core abstractions that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Create SandboxProvider interface and types in app/lib/sandbox/types.ts (from contracts/sandbox-provider.ts)
- [x] T006 [P] Create shared sandbox types (CommandOutput, CommandResult, SnapshotResult) in app/types/sandbox.ts
- [x] T007 [P] Create Zod schemas for API routes in app/lib/sandbox/schemas.ts (from contracts/api-routes.ts)
- [x] T008 Create SandboxStore with Nanostores in app/lib/stores/sandbox.ts (from contracts/stores.ts)
- [x] T009 Create sandbox provider factory in app/lib/sandbox/index.ts with createSandboxProvider()
- [x] T010 Refactor existing WebContainer code into WebContainerProvider class in app/lib/sandbox/providers/webcontainer.ts

**Checkpoint**: Foundation ready - Provider abstraction in place, WebContainer still works

---

## Phase 3: User Story 1 - Fast Preview Updates (Priority: P1) 🎯 MVP

**Goal**: Users see preview updates within 5 seconds of file changes when using cloud provider

**Independent Test**: Modify a file via prompt → preview reflects change within 5 seconds

### Implementation for User Story 1

- [x] T011 [P] [US1] Create POST /api/sandbox/create route in app/routes/api.sandbox.create.ts
- [x] T012 [P] [US1] Create POST /api/sandbox/files route for batch writes in app/routes/api.sandbox.files.ts
- [x] T013 [P] [US1] Create GET /api/sandbox/files route for file reads in app/routes/api.sandbox.files.$path.ts
- [x] T014 [P] [US1] Create POST /api/sandbox/command route with SSE streaming in app/routes/api.sandbox.command.ts
- [x] T015 [US1] Implement VercelSandboxProvider class in app/lib/sandbox/providers/vercel-sandbox.ts
- [x] T016 [US1] Implement FileSyncManager for incremental file sync in app/lib/sandbox/file-sync.ts
- [x] T017 [US1] Refactor ActionRunner to use SandboxProvider abstraction in app/lib/runtime/action-runner.ts
- [x] T018 [US1] Update FilesStore to sync via provider in app/lib/stores/files.ts
- [x] T019 [US1] Update PreviewsStore to handle both URL types in app/lib/stores/previews.ts
- [x] T020 [US1] Wire provider initialization in WorkbenchStore.initializeProvider() in app/lib/stores/workbench.ts

**Checkpoint**: US1 complete - File changes sync to cloud sandbox and preview updates within 5s

---

## Phase 4: User Story 2 - Session Persistence (Priority: P1)

**Goal**: Workspace state survives browser refresh and can reconnect to active sessions

**Independent Test**: Refresh browser (F5) → workspace restores to previous state within 3 seconds

### Implementation for User Story 2

- [x] T021 [P] [US2] Create POST /api/sandbox/reconnect route in app/routes/api.sandbox.reconnect.ts
- [x] T022 [P] [US2] Create GET /api/sandbox/status route in app/routes/api.sandbox.status.ts
- [x] T023 [P] [US2] Create POST /api/sandbox/extend route in app/routes/api.sandbox.extend.ts
- [x] T024 [P] [US2] Create POST /api/sandbox/stop route in app/routes/api.sandbox.stop.ts
- [x] T025 [US2] Implement TimeoutManager with activity tracking in app/lib/sandbox/timeout-manager.ts
- [x] T026 [US2] Add reconnect() method to VercelSandboxProvider in app/lib/sandbox/providers/vercel-sandbox.ts
- [x] T027 [US2] Store sandboxId on project record via projects.server.ts in app/lib/services/projects.server.ts
- [x] T028 [US2] Implement reconnectOrRestore() in WorkbenchStore in app/lib/stores/workbench.ts
- [x] T029 [US2] Add timeout warning toast notification in app/components/workbench/TimeoutWarning.tsx
- [x] T030 [US2] Integrate timeout warning into Workbench component in app/components/workbench/Workbench.client.tsx

**Checkpoint**: US2 complete - Browser refresh reconnects to sandbox, timeout warnings shown

---

## Phase 5: User Story 3 - Provider Configuration (Priority: P2) - SIMPLIFIED FOR MVP

**Goal**: Admin-configured provider via environment variable. No user selection UI for MVP.

**MVP Approach**: Set `SANDBOX_PROVIDER_DEFAULT=vercel` in `.env.local` to use Vercel Sandbox for all projects.

**Rationale**: For MVP, we want consistent behavior and simplified UX. Users see status indicator only.

### Implementation for User Story 3 (Simplified MVP)

- [x] T031 [P] [US3] Create PATCH /api/user/sandbox-preference route in app/routes/api.user.sandbox-preference.ts (kept for future use)
- [x] T032 ~~Create ProviderSelector component~~ REMOVED - No user selection for MVP
- [x] T033 [US3] Create SandboxSettings tab component in app/components/@settings/tabs/sandbox/SandboxTab.tsx (read-only status display)
- [x] T034 [US3] Add sandbox tab to settings panel in app/components/@settings/core/constants.tsx
- [x] T035 [US3] Implement switchProvider() in WorkbenchStore in app/lib/stores/workbench.ts (admin use only)
- [x] T036 [US3] Add provider status indicator to Workbench header in app/components/workbench/ProviderBadge.tsx (read-only)

### Configuration (Admin Only)

```bash
# .env.local - Set provider for all users
SANDBOX_PROVIDER_DEFAULT=vercel        # Use Vercel Sandbox (cloud) - MVP DEFAULT
SANDBOX_PROVIDER_DEFAULT=webcontainer  # Use WebContainer (local browser)
```

**Checkpoint**: US3 complete - Provider set via env var, users see read-only status indicator

---

## Phase 6: User Story 4 - Reduced Local Resource Usage (Priority: P2)

**Goal**: Cloud provider offloads CPU/RAM, keeping local machine responsive

**Independent Test**: Run build with cloud provider → local CPU stays below 30%

### Implementation for User Story 4

- [x] T037 [US4] Add resource usage telemetry to VercelSandboxProvider in app/lib/sandbox/providers/vercel-sandbox.ts
- [x] T038 [US4] Add provider type indicator showing "Local" vs "Cloud" in app/components/workbench/ProviderBadge.tsx
- [x] T039 [US4] Ensure all heavy operations route through provider (no direct WebContainer calls) in app/lib/runtime/action-runner.ts

**Checkpoint**: US4 complete - Cloud execution reduces local resource usage

---

## Phase 7: User Story 5 - Snapshot-Based Fast Starts (Priority: P3)

**Goal**: Projects with snapshots become ready-to-edit in under 10 seconds

**Independent Test**: Reopen project that has a snapshot → ready in under 10 seconds

### Implementation for User Story 5

- [x] T040 [P] [US5] Create POST /api/sandbox/snapshot route in app/routes/api.sandbox.snapshot.ts ⚠️ **PLACEHOLDER** - Vercel SDK lacks snapshot support
- [x] T041 [P] [US5] Create POST /api/sandbox/snapshot/:id/restore route in app/routes/api.sandbox.snapshot.$id.restore.ts ⚠️ **PLACEHOLDER**
- [x] T042 [US5] Implement createSnapshot() in VercelSandboxProvider in app/lib/sandbox/providers/vercel-sandbox.ts ⚠️ **PLACEHOLDER**
- [x] T043 [US5] Implement restoreFromSnapshot() in VercelSandboxProvider in app/lib/sandbox/providers/vercel-sandbox.ts ⚠️ **PLACEHOLDER**
- [ ] T044 [US5] Add vercel_snapshot_id storage to project_snapshots table in app/lib/services/projects.server.ts
- [x] T045 [US5] Implement auto-snapshot on warning and timeout in WorkbenchStore._setupTimeoutManager() in app/lib/stores/workbench.ts ✅ **IMPLEMENTED** - Saves snapshot on warning (2 min before) and on timeout
- [ ] T046 [US5] Implement snapshot restoration in initializeProvider() in app/lib/stores/workbench.ts

**Checkpoint**: US5 partial - Routes exist but return placeholder data; waiting for Vercel SDK snapshot support

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T047 [P] Add error handling for Vercel API failures in all api.sandbox.*.ts routes
- [ ] T048 [P] Add rate limiting to sandbox API routes using existing withSecurity pattern ⚠️ **SKIPPED** - deferred for MVP
- [x] T049 [P] Add logging for sandbox operations using existing telemetry patterns
- [x] T050 Update CLAUDE.md with sandbox provider architecture notes
- [x] T051 Run quickstart.md validation steps to verify end-to-end flow
- [x] T052 Add feature flag SANDBOX_VERCEL_ENABLED kill switch check to all Vercel routes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-7)**: All depend on Foundational phase completion
  - US1 + US2 can proceed in parallel (both P1)
  - US3 + US4 can proceed in parallel (both P2) after US1
  - US5 depends on US1 + US2 for snapshot infrastructure
- **Polish (Phase 8)**: Depends on all user stories being complete

### User Story Dependencies

```
Phase 1 (Setup)
     │
     ▼
Phase 2 (Foundational)
     │
     ├──────────────────────┐
     │                      │
     ▼                      ▼
Phase 3 (US1)         Phase 4 (US2)
Fast Preview          Session Persistence
     │                      │
     ├──────────────────────┤
     │                      │
     ▼                      ▼
Phase 5 (US3)         Phase 6 (US4)
Provider Selection    Resource Usage
     │                      │
     └──────────┬───────────┘
                │
                ▼
         Phase 7 (US5)
         Snapshots
                │
                ▼
         Phase 8 (Polish)
```

### Within Each User Story

- API routes before provider implementation
- Provider implementation before store integration
- Store integration before UI components
- Core implementation before refinements

### Parallel Opportunities

**Phase 1 (Setup):**
```bash
# Run in parallel:
T003: Database migration
T004: Environment variables
```

**Phase 2 (Foundational):**
```bash
# Run in parallel:
T006: Shared types in app/types/sandbox.ts
T007: Zod schemas in app/lib/sandbox/schemas.ts
```

**Phase 3 (US1):**
```bash
# Run API routes in parallel:
T011: api.sandbox.create.ts
T012: api.sandbox.files.ts
T013: api.sandbox.files.$path.ts
T014: api.sandbox.command.ts
```

**Phase 4 (US2):**
```bash
# Run API routes in parallel:
T021: api.sandbox.reconnect.ts
T022: api.sandbox.status.ts
T023: api.sandbox.extend.ts
T024: api.sandbox.stop.ts
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1 (Fast Preview)
4. **STOP and VALIDATE**: Test file sync and preview updates
5. Deploy/demo if ready - users can now use cloud sandbox

### Incremental Delivery

1. Setup + Foundational → Provider abstraction works
2. Add US1 (Fast Preview) → Cloud execution works, preview updates fast
3. Add US2 (Session Persistence) → Refresh doesn't lose work
4. Add US3 (Provider Selection) → Users can choose local/cloud
5. Add US5 (Snapshots) → Projects start instantly from snapshots
6. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1 (Fast Preview)
   - Developer B: User Story 2 (Session Persistence)
3. After US1 + US2:
   - Developer A: User Story 3 (Provider Selection)
   - Developer B: User Story 5 (Snapshots)
4. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- US4 (Resource Usage) is mostly achieved by US1 implementation
- Vercel Sandbox SDK requires server-side only (never expose to client)
- All API routes must verify project ownership before sandbox operations
