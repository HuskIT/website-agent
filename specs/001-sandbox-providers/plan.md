# Implementation Plan: Multi-Sandbox Provider Support

**Branch**: `001-sandbox-providers` | **Date**: 2026-02-04 | **Spec**: [spec.md](./spec.md)
**Last Updated**: 2026-02-05 | **Implementation Status**: ~90% Complete
**Input**: Feature specification from `/specs/001-sandbox-providers/spec.md`

## Summary

Implement a provider abstraction layer to support multiple sandbox backends (WebContainer for local execution, Vercel Sandbox for cloud execution). The current WebContainer integration is tightly coupled throughout the codebase (ActionRunner, stores, terminal). This plan introduces a `SandboxProvider` interface that both providers implement, with server-side API routes proxying Vercel Sandbox operations to protect credentials.

**Key architectural decisions from clarification:**
1. **Replace architecture**: Cloud provider replaces WebContainer as Tier 1 (not mirror)
2. **On-demand sessions**: Create sandbox when project opens, reconnect if active
3. **Platform-managed auth**: HuskIT owns Vercel credentials, server-side only
4. **Cloud-first default**: New projects use Vercel Sandbox by default
5. **Activity-based timeout**: Extend only on user activity, auto-snapshot before expiry

## Technical Context

**Language/Version**: TypeScript 5.7.2 (strict mode)
**Primary Dependencies**:
- Remix 2.15.2 with Vite 5.4.11
- React 18.3.1
- @webcontainer/api 1.6.1 (existing local provider)
- @vercel/sandbox (new cloud provider)
- Nanostores (reactive state)
- Zustand (complex state)

**Storage**:
- Tier 1 (Runtime): WebContainer FS or Vercel Sandbox FS (authoritative)
- Tier 2 (Browser): IndexedDB via `boltHistory` database
- Tier 3 (Server): Supabase PostgreSQL (`project_snapshots`, `projects` tables)

**Testing**: Vitest (unit/integration), Playwright (E2E), MSW (API mocking)
**Target Platform**: Cloudflare Pages (30s edge timeout), modern browsers
**Project Type**: Web application (Remix fullstack)

**Performance Goals**:
- Preview updates: <5 seconds (95th percentile)
- Session restore: <3 seconds (95th percentile)
- Snapshot startup: <10 seconds

**Constraints**:
- Cloudflare Pages 30s timeout (affects snapshot operations)
- Vercel Sandbox timeout: 5min default, 45min hobby, 5hr pro
- Vercel Sandbox snapshot expiry: 7 days
- Project size: <500MB
- Platform quota: Shared across all users

**Scale/Scope**:
- Active concurrent users: ~100 initially
- Average project size: 10-50 files
- Sandbox sessions per day: ~500 (estimate)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution is a template without specific gates. Applying the constitution principles from CLAUDE.md:

| Principle | Status | Notes |
|-----------|--------|-------|
| Code Quality (Zod contracts) | ✅ PASS | Will define Zod schemas for SandboxProvider interface |
| Testing Discipline | ✅ PASS | SSE integration tests for provider operations, Vitest unit tests |
| UX Consistency | ✅ PASS | shadcn toasts for status, ARIA live regions for state changes |
| Performance Budgets | ✅ PASS | Instrumented metrics for SLA compliance (5s preview, 3s restore) |
| Server-only secrets | ✅ PASS | Vercel tokens server-side only, proxied via API routes |

**No violations requiring justification.**

## Project Structure

### Documentation (this feature)

```text
specs/001-sandbox-providers/
├── spec.md              # Feature specification (complete)
├── plan.md              # This file
├── research.md          # Phase 0 output (Vercel SDK patterns)
├── data-model.md        # Phase 1 output (entity definitions)
├── quickstart.md        # Phase 1 output (setup instructions)
├── contracts/           # Phase 1 output (API schemas)
│   ├── sandbox-provider.ts    # SandboxProvider interface
│   ├── api-routes.ts          # Server API contracts
│   └── stores.ts              # Store type definitions
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root) - ACTUAL IMPLEMENTATION

```text
app/
├── lib/
│   ├── sandbox/                    # ✅ IMPLEMENTED: Provider abstraction layer
│   │   ├── index.ts               # Factory: createSandboxProvider(), resolveProviderType()
│   │   ├── types.ts               # SandboxProvider interface + Zod schemas
│   │   ├── schemas.ts             # API route request/response Zod schemas
│   │   ├── providers/
│   │   │   ├── webcontainer.ts    # ✅ WebContainerProvider class
│   │   │   └── vercel-sandbox.ts  # ✅ VercelSandboxProvider class (API proxy)
│   │   ├── file-sync.ts           # ✅ FileSyncManager with debouncing
│   │   ├── timeout-manager.ts     # ✅ TimeoutManager with activity tracking
│   │   └── vercel-terminal.ts     # Terminal integration for Vercel
│   │
│   ├── webcontainer/              # EXISTING: WebContainer singleton
│   │   └── index.ts               # Used by WebContainerProvider
│   │
│   ├── stores/
│   │   ├── sandbox.ts             # ✅ NEW: SandboxState atom, actions, computed
│   │   ├── files.ts               # ✅ MODIFIED: Provider-aware file sync
│   │   ├── previews.ts            # ✅ MODIFIED: Multi-provider preview URLs
│   │   ├── terminal.ts            # ✅ MODIFIED: Provider-aware terminal
│   │   └── workbench.ts           # ✅ MODIFIED: initializeProvider(), switchProvider()
│   │
│   └── runtime/
│       └── action-runner.ts       # ✅ MODIFIED: Uses SandboxProvider abstraction
│
├── routes/                        # ✅ 10 API routes implemented
│   ├── api.sandbox.create.ts      # POST - Create Vercel Sandbox
│   ├── api.sandbox.reconnect.ts   # POST - Reconnect to existing sandbox
│   ├── api.sandbox.files.ts       # POST - Batch file writes
│   ├── api.sandbox.files.$path.ts # GET - Read single file
│   ├── api.sandbox.command.ts     # POST - Execute command (SSE streaming)
│   ├── api.sandbox.snapshot.ts    # POST - Create snapshot
│   ├── api.sandbox.snapshot.$id.restore.ts # POST - Restore from snapshot
│   ├── api.sandbox.status.ts      # GET - Get sandbox status
│   ├── api.sandbox.extend.ts      # POST - Extend timeout
│   ├── api.sandbox.stop.ts        # POST - Stop sandbox
│   └── api.user.sandbox-preference.ts # PATCH - Update user preference
│
├── components/
│   ├── @settings/
│   │   ├── core/
│   │   │   ├── ControlPanel.tsx   # ✅ MODIFIED: Added sandbox tab
│   │   │   ├── constants.tsx      # ✅ MODIFIED: TAB_LABELS, settingsTabsAtom
│   │   │   └── types.ts           # ✅ MODIFIED: Added 'sandbox' to TabType
│   │   └── tabs/
│   │       └── sandbox/           # ✅ NEW: Provider settings UI
│   │           └── SandboxTab.tsx # Read-only status display
│   │
│   └── workbench/
│       ├── ProviderBadge.tsx      # ✅ NEW: Shows "Local" vs "Cloud" indicator
│       ├── TimeoutWarning.tsx     # ✅ NEW: Timeout warning toast
│       └── Workbench.client.tsx   # ✅ MODIFIED: Integrates timeout warning
│
└── types/
    ├── sandbox.ts                 # ✅ NEW: Re-exports + extended types
    └── project.ts                 # ✅ MODIFIED: sandbox_id, sandbox_provider fields

supabase/migrations/
└── 20260204223702_add_sandbox_columns.sql  # ✅ Database migration

tests/
├── sandbox-api-tests.sh           # Shell-based API tests
├── sandbox-mvp-verify.sh          # MVP verification script
├── sandbox-test-runner.sh         # Test runner
├── sandbox-validation.md          # Manual testing checklist
└── vercel-sandbox-test.ts         # Vercel SDK integration test
```

**Structure Decision**: Web application structure with new `app/lib/sandbox/` module for provider abstraction. Server-side API routes (`api.sandbox.*`) proxy all Vercel operations. Existing WebContainer code refactored to implement the new interface.

## Complexity Tracking

No complexity violations to justify. The provider abstraction follows established patterns (similar to LLM provider registry in `app/lib/modules/llm/`).

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CLIENT (Browser)                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                  │
│  │ ActionRunner│───▶│SandboxStore │───▶│ FilesStore  │                  │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘                  │
│         │                  │                  │                          │
│         ▼                  ▼                  ▼                          │
│  ┌────────────────────────────────────────────────────────────┐         │
│  │              SandboxProvider Interface                      │         │
│  │  - writeFile(path, content)                                │         │
│  │  - readFile(path) → content                                │         │
│  │  - runCommand(cmd, args) → stdout/stderr stream            │         │
│  │  - getPreviewUrl(port) → url                               │         │
│  │  - createSnapshot() → snapshotId                           │         │
│  │  - restoreFromSnapshot(snapshotId)                         │         │
│  │  - status → connected | loading | error                    │         │
│  └────────────────────────────────────────────────────────────┘         │
│              │                              │                            │
│              ▼                              ▼                            │
│  ┌─────────────────────┐      ┌─────────────────────┐                   │
│  │ WebContainerProvider│      │VercelSandboxProvider│                   │
│  │  (local, in-browser)│      │  (cloud, via API)   │                   │
│  │                     │      │                     │                   │
│  │ webcontainer.fs.*   │      │ fetch('/api/sandbox │                   │
│  │ webcontainer.spawn()│      │      /files')       │                   │
│  │ webcontainer.on()   │      │                     │                   │
│  └─────────────────────┘      └──────────┬──────────┘                   │
│                                          │                               │
└──────────────────────────────────────────┼───────────────────────────────┘
                                           │
                                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        SERVER (Cloudflare Pages)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────┐        │
│  │                    API Routes (api.sandbox.*)                │        │
│  │                                                              │        │
│  │  POST /api/sandbox/create    → Sandbox.create()             │        │
│  │  POST /api/sandbox/reconnect → Sandbox.get(sandboxId)       │        │
│  │  POST /api/sandbox/files     → sandbox.writeFiles()         │        │
│  │  POST /api/sandbox/command   → sandbox.runCommand()         │        │
│  │  POST /api/sandbox/snapshot  → sandbox.snapshot()           │        │
│  │                                                              │        │
│  │  Auth: requireSession() + project ownership                 │        │
│  │  Credentials: VERCEL_TEAM_ID, VERCEL_PROJECT_ID, VERCEL_TOKEN│        │
│  └─────────────────────────────────────────────────────────────┘        │
│                               │                                          │
│                               ▼                                          │
│                    ┌─────────────────────┐                              │
│                    │   Vercel Sandbox    │                              │
│                    │   (Cloud microVM)   │                              │
│                    └─────────────────────┘                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Integration Points

### 1. ActionRunner Refactoring

Current coupling:
```typescript
// action-runner.ts
const webcontainer = await this.#webcontainer;
await webcontainer.fs.writeFile(path, content);
```

Refactored to:
```typescript
// action-runner.ts
const provider = await this.#sandboxProvider;
await provider.writeFile(path, content);
```

### 2. Preview URL Handling

| Provider | URL Pattern | Mechanism |
|----------|-------------|-----------|
| WebContainer | `https://{id}.local-credentialless.webcontainer-api.io` | `webcontainer.on('server-ready')` |
| Vercel Sandbox | `https://{sandboxId}-{port}.vercel-sandbox.com` | `sandbox.domain(port)` |

### 3. Session State on Project

New fields on `projects` table:
```sql
ALTER TABLE projects ADD COLUMN sandbox_id TEXT;
ALTER TABLE projects ADD COLUMN sandbox_provider TEXT DEFAULT 'vercel';
ALTER TABLE projects ADD COLUMN sandbox_expires_at TIMESTAMPTZ;
```

### 4. User Provider Preference

New field on `user` table (Better Auth):
```sql
ALTER TABLE user ADD COLUMN preferred_sandbox_provider TEXT DEFAULT 'vercel';
```

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Vercel Sandbox API rate limits | Implement request queuing, honor 429 responses |
| Timeout during long builds | Activity detection + auto-extend, warn user |
| Network interruption | Auto-snapshot periodically, reconnect logic |
| Credential exposure | Server-side only, never in client bundle |
| Cost overrun | Monitor usage, implement soft limits per user |
| WebContainer regression | Feature flag to force local provider |

## Next Steps

1. **Phase 0**: Generate `research.md` with Vercel SDK deep-dive
2. **Phase 1**: Generate `data-model.md`, `contracts/`, `quickstart.md`
3. **Phase 2**: Generate `tasks.md` via `/speckit.tasks`
