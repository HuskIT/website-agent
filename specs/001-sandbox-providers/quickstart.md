# Quickstart: Multi-Sandbox Provider Support

**Feature**: 001-sandbox-providers
**Date**: 2026-02-04
**Last Updated**: 2026-02-05
**Implementation Status**: ✅ Ready for Use

This guide walks through setting up the multi-sandbox provider system for local development.

## Prerequisites

- Node.js >= 18.18.0
- pnpm >= 8.0.0
- PostgreSQL database (via Supabase)
- Vercel account with Sandbox access (for cloud provider)

## Environment Setup

### 1. Required Environment Variables

Add these variables to your `.env.local` file:

```bash
# Vercel Sandbox Configuration (required for cloud provider)
VERCEL_TEAM_ID=team_xxxxxxxxxx          # Your Vercel team ID
VERCEL_PROJECT_ID=prj_xxxxxxxxxx        # Vercel project for sandbox
VERCEL_TOKEN=xxxxxxxxxxxxxxxxxx          # Vercel API token with sandbox scope

# Feature Flags
SANDBOX_PROVIDER_DEFAULT=vercel          # Default provider: 'webcontainer' | 'vercel'
SANDBOX_VERCEL_ENABLED=true              # Enable/disable Vercel provider

# Existing Database (already configured)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=xxx
DATABASE_URL=postgresql://...
```

### 2. Obtain Vercel Credentials

1. **Team ID**: Go to Vercel Dashboard → Settings → General → Team ID
2. **Project ID**: Create a project for sandboxes or use existing → Settings → General → Project ID
3. **API Token**: Account Settings → Tokens → Create Token with `sandbox:write` scope

## Database Migration

Run the migration to add sandbox columns:

```bash
# Option 1: Via pnpm script (if configured)
pnpm run migrate:sandbox

# Option 2: Manual migration via Supabase CLI
supabase db push

# Option 3: Direct SQL execution
psql $DATABASE_URL -f supabase/migrations/YYYYMMDDHHMMSS_add_sandbox_columns.sql
```

### Migration SQL Reference

```sql
-- Add sandbox session tracking to projects
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS sandbox_id TEXT,
  ADD COLUMN IF NOT EXISTS sandbox_provider VARCHAR(20) DEFAULT 'vercel',
  ADD COLUMN IF NOT EXISTS sandbox_expires_at TIMESTAMPTZ;

-- Add provider preference to users
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS preferred_sandbox_provider VARCHAR(20) DEFAULT 'vercel';

-- Add Vercel snapshot reference to project_snapshots
ALTER TABLE project_snapshots
  ADD COLUMN IF NOT EXISTS vercel_snapshot_id TEXT;

-- Index for quick sandbox lookup
CREATE INDEX IF NOT EXISTS idx_projects_sandbox_id
  ON projects(sandbox_id)
  WHERE sandbox_id IS NOT NULL;
```

## Install Dependencies

```bash
# Install the Vercel Sandbox SDK
pnpm add @vercel/sandbox

# Install existing dependencies
pnpm install
```

## Development Workflow

### Starting Development Server

```bash
pnpm run dev
```

The development server starts at `http://localhost:5171`.

### Provider Selection

By default, new projects use the provider specified by `SANDBOX_PROVIDER_DEFAULT`. Users can override this in their settings.

**Provider Resolution Order**:
1. User preference (`user.preferred_sandbox_provider`)
2. Environment default (`SANDBOX_PROVIDER_DEFAULT`)
3. Fallback to `vercel`

### Testing Provider Switching

1. Open a project in the workbench
2. Go to Settings → Sandbox
3. Select preferred provider
4. The system will:
   - Save current state as snapshot
   - Switch to new provider
   - Restore from snapshot

## API Routes Reference

| Route | Method | Description | Schema |
|-------|--------|-------------|--------|
| `/api/sandbox/create` | POST | Create new sandbox session | `CreateSandboxRequest` → `CreateSandboxResponse` |
| `/api/sandbox/reconnect` | POST | Reconnect to existing sandbox | `ReconnectSandboxRequest` → `ReconnectSandboxResponse` |
| `/api/sandbox/files` | POST | Write files to sandbox (batch) | `WriteFilesRequest` → `WriteFilesResponse` |
| `/api/sandbox/files/:path` | GET | Read file from sandbox | `ReadFileRequest` → `ReadFileResponse` |
| `/api/sandbox/command` | POST | Execute command (SSE streaming) | `RunCommandRequest` → SSE events |
| `/api/sandbox/snapshot` | POST | Create snapshot | `CreateSnapshotRequest` → `CreateSnapshotResponse` |
| `/api/sandbox/snapshot/:id/restore` | POST | Restore from snapshot | `RestoreSnapshotRequest` → `RestoreSnapshotResponse` |
| `/api/sandbox/status` | GET | Get sandbox status | `GetSandboxStatusRequest` → `GetSandboxStatusResponse` |
| `/api/sandbox/extend` | POST | Extend timeout (cloud only) | `ExtendTimeoutRequest` → `ExtendTimeoutResponse` |
| `/api/sandbox/stop` | POST | Stop sandbox (with auto-snapshot) | `StopSandboxRequest` → `StopSandboxResponse` |
| `/api/user/sandbox-preference` | PATCH | Update user's provider preference | `UpdateSandboxPreferenceRequest` → `UpdateSandboxPreferenceResponse` |

**Schema definitions**: See `app/lib/sandbox/schemas.ts` for all Zod schemas.

## Testing

### Unit Tests

```bash
# Run all sandbox tests
pnpm test -- --grep sandbox

# Run specific provider tests
pnpm test -- tests/unit/sandbox/providers/
```

### Integration Tests

```bash
# Run sandbox API route tests
pnpm test -- tests/integration/sandbox/
```

### Manual Testing Checklist

- [ ] Create new project → Verify sandbox connects
- [ ] Write file → Verify it appears in preview
- [ ] Run shell command → Verify output streams
- [ ] Idle for 4+ minutes → Verify timeout warning appears
- [ ] Switch providers → Verify state preserved
- [ ] Close and reopen project → Verify reconnection works

## Troubleshooting

### Common Issues

**1. "Sandbox creation failed"**
- Verify `VERCEL_TOKEN` has correct scopes
- Check `VERCEL_TEAM_ID` is correct
- Ensure Vercel Sandbox is enabled for your account

**2. "Preview URL not loading"**
- WebContainer: Check COEP/COOP headers are set
- Vercel: Verify port is exposed (1000-9999 range)

**3. "Command execution timeout"**
- Cloudflare Pages has 30s limit
- For long commands, use detached mode

**4. "Session expired"**
- Vercel sandboxes timeout after inactivity
- User activity extends timeout automatically
- Auto-snapshot triggers before expiry

### Debug Mode

Enable verbose logging:

```bash
DEBUG=sandbox:* pnpm run dev
```

## Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| `SANDBOX_VERCEL_ENABLED` | `true` | Kill switch for Vercel provider |
| `SANDBOX_PROVIDER_DEFAULT` | `vercel` | Default provider for new projects |

To force local-only mode:

```bash
SANDBOX_VERCEL_ENABLED=false pnpm run dev
```

## Architecture Summary

```
┌─────────────────┐     ┌─────────────────┐
│  ActionRunner   │────▶│  SandboxStore   │
└────────┬────────┘     └────────┬────────┘
         │                       │
         ▼                       ▼
┌─────────────────────────────────────────┐
│         SandboxProvider Interface        │
├─────────────────┬───────────────────────┤
│ WebContainer    │   Vercel Sandbox      │
│ (local/browser) │   (cloud/server)      │
└─────────────────┴───────────────────────┘
```

## Implementation Files Reference

### Core Sandbox Module
| File | Purpose |
|------|---------|
| `app/lib/sandbox/index.ts` | Factory: `createSandboxProvider()`, `resolveProviderType()` |
| `app/lib/sandbox/types.ts` | `SandboxProvider` interface + all Zod type schemas |
| `app/lib/sandbox/schemas.ts` | API request/response Zod schemas |
| `app/lib/sandbox/providers/webcontainer.ts` | Local browser-based provider |
| `app/lib/sandbox/providers/vercel-sandbox.ts` | Cloud provider (API proxy) |
| `app/lib/sandbox/file-sync.ts` | `FileSyncManager` - debounced batch writes |
| `app/lib/sandbox/timeout-manager.ts` | `TimeoutManager` - activity tracking |

### Stores (Nanostores)
| File | Purpose |
|------|---------|
| `app/lib/stores/sandbox.ts` | Provider state, status, timeout tracking |
| `app/lib/stores/workbench.ts` | `initializeProvider()`, `switchProvider()` |
| `app/lib/stores/files.ts` | Provider-aware file operations |
| `app/lib/stores/previews.ts` | Multi-provider preview URLs |
| `app/lib/stores/terminal.ts` | Provider-aware terminal |

### UI Components
| File | Purpose |
|------|---------|
| `app/components/@settings/tabs/sandbox/SandboxTab.tsx` | Settings panel |
| `app/components/workbench/ProviderBadge.tsx` | "Local"/"Cloud" indicator |
| `app/components/workbench/TimeoutWarning.tsx` | Timeout warning toast |

### Types
| File | Purpose |
|------|---------|
| `app/types/sandbox.ts` | Re-exports + `ExtendedPreviewInfo`, `FileSyncState`, `SandboxSettings` |
| `app/types/project.ts` | Extended with `sandbox_id`, `sandbox_provider` fields |

## Next Steps

After completing setup:

1. Run tests to verify configuration
2. Create a test project to validate end-to-end flow
3. Monitor Vercel Sandbox usage in dashboard
4. Review `specs/001-sandbox-providers/plan.md` for implementation details
