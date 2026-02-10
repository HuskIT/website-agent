# Data Model: Multi-Sandbox Provider Support

**Feature**: 001-sandbox-providers
**Date**: 2026-02-04
**Last Updated**: 2026-02-05
**Implementation Status**: ✅ Fully Implemented

## Implementation Notes

The database schema and runtime types have been fully implemented:
- **Migration**: `supabase/migrations/20260204223702_add_sandbox_columns.sql`
- **Types**: `app/lib/sandbox/types.ts` (with Zod schemas)
- **Store**: `app/lib/stores/sandbox.ts` (Nanostores)
- **Shared Types**: `app/types/sandbox.ts` (re-exports + extensions)

## Entity Relationship Diagram

```
┌─────────────────────┐
│        User         │
├─────────────────────┤
│ id (PK)             │
│ email               │
│ preferred_sandbox   │◄─────── New field
│ ...                 │
└─────────┬───────────┘
          │
          │ 1:N
          ▼
┌─────────────────────┐         ┌─────────────────────┐
│      Project        │         │   SandboxSession    │
├─────────────────────┤         ├─────────────────────┤
│ id (PK)             │◄───────▶│ sandbox_id (unique) │ Runtime state (not persisted)
│ user_id (FK)        │         │ project_id          │
│ name                │         │ provider_type       │
│ sandbox_id          │◄────────│ status              │
│ sandbox_provider    │         │ timeout_remaining   │
│ sandbox_expires_at  │         │ created_at          │
│ ...                 │         └─────────────────────┘
└─────────┬───────────┘
          │
          │ 1:1
          ▼
┌─────────────────────┐
│  ProjectSnapshot    │
├─────────────────────┤
│ id (PK)             │
│ project_id (FK)     │
│ files (JSONB)       │
│ vercel_snapshot_id  │◄─────── New field
│ summary             │
│ created_at          │
│ updated_at          │
└─────────────────────┘
```

---

## Entity Definitions

### 1. User (Modified)

**Table**: `user` (Better Auth managed)

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK | User identifier |
| email | VARCHAR(255) | NOT NULL, UNIQUE | User email |
| **preferred_sandbox_provider** | VARCHAR(20) | DEFAULT 'vercel' | User's preferred provider: 'webcontainer' or 'vercel' |
| ... | ... | ... | Existing fields unchanged |

**Validation Rules**:
- `preferred_sandbox_provider` must be one of: `'webcontainer'`, `'vercel'`

**State Transitions**: None (static preference)

---

### 2. Project (Modified)

**Table**: `projects`

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK | Project identifier |
| user_id | UUID | FK → user.id, NOT NULL | Owner |
| name | VARCHAR(255) | NOT NULL | Project name |
| **sandbox_id** | TEXT | NULLABLE | Active Vercel Sandbox session ID |
| **sandbox_provider** | VARCHAR(20) | DEFAULT 'vercel' | Current provider for this project |
| **sandbox_expires_at** | TIMESTAMPTZ | NULLABLE | When sandbox session expires |
| business_profile | JSONB | NULLABLE | Crawler data |
| status | VARCHAR(50) | NULLABLE | Project status |
| url_id | VARCHAR(255) | UNIQUE | URL-friendly slug |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation time |
| updated_at | TIMESTAMPTZ | DEFAULT NOW() | Last update |

**Validation Rules**:
- `sandbox_id` is set when a Vercel Sandbox session is active
- `sandbox_id` is cleared when session expires or user disconnects
- `sandbox_expires_at` must be in the future when `sandbox_id` is set
- `sandbox_provider` must be one of: `'webcontainer'`, `'vercel'`

**State Transitions**:

```
                          ┌─────────────────┐
                          │    No Sandbox   │
                          │  (sandbox_id =  │
                          │      null)      │
                          └────────┬────────┘
                                   │
                     user opens project
                       (cloud provider)
                                   │
                                   ▼
                          ┌─────────────────┐
         user switches    │ Sandbox Active  │   timeout expires
         to local ◄───────│  (sandbox_id =  │──────► auto-snapshot
                          │   'sbx_xxx')    │        + clear ID
                          └────────┬────────┘
                                   │
                        user closes project
                         (with auto-snapshot)
                                   │
                                   ▼
                          ┌─────────────────┐
                          │    No Sandbox   │
                          │  (sandbox_id =  │
                          │      null)      │
                          └─────────────────┘
```

---

### 3. ProjectSnapshot (Modified)

**Table**: `project_snapshots`

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK | Snapshot identifier |
| project_id | UUID | FK → projects.id, UNIQUE | One snapshot per project |
| files | JSONB | NOT NULL | FileMap structure |
| **vercel_snapshot_id** | TEXT | NULLABLE | Vercel Sandbox snapshot ID (if created via cloud) |
| summary | TEXT | NULLABLE | Human-readable summary |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation time |
| updated_at | TIMESTAMPTZ | DEFAULT NOW() | Last update |

**Validation Rules**:
- `files` must be valid FileMap structure (paths → file/folder objects)
- `files` size must be < 50MB
- `vercel_snapshot_id` format: `snap_[a-zA-Z0-9]+`

**Relationship to Vercel Snapshots**:
- When using Vercel Sandbox, a `vercel_snapshot_id` can be stored for faster restoration
- Vercel snapshots expire after 7 days; `files` JSONB is the permanent backup
- Restoration priority: Vercel snapshot (if valid) → files JSONB

---

### 4. SandboxSession (Runtime Only - Not Persisted)

**Location**: Client-side Nanostores (`app/lib/stores/sandbox.ts`)

| Field | Type | Description |
|-------|------|-------------|
| sandboxId | string | null | Active sandbox ID |
| projectId | string | null | Associated project |
| providerType | 'webcontainer' | 'vercel' | Current provider |
| status | SandboxStatus | Connection state |
| timeoutRemaining | number | null | MS until timeout (cloud only) |
| previewUrls | Map<number, string> | Port → URL mapping |
| lastActivity | number | Last activity timestamp |
| error | string | null | Last error message |

**Status Values**:
```typescript
type SandboxStatus =
  | 'disconnected'   // No sandbox active
  | 'connecting'     // Initialization in progress
  | 'connected'      // Ready for operations
  | 'reconnecting'   // Reconnection attempt in progress
  | 'error';         // Fatal error, needs restart
```

---

### 5. SandboxProvider (Interface - Runtime)

**Location**: `app/lib/sandbox/types.ts`

```typescript
interface SandboxProvider {
  // Identity
  readonly type: 'webcontainer' | 'vercel';
  readonly sandboxId: string | null;

  // Lifecycle
  connect(projectId: string, snapshotId?: string): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(sandboxId: string): Promise<boolean>; // Returns false if session expired

  // Status
  readonly status: SandboxStatus;
  readonly timeoutRemaining: number | null; // null for WebContainer
  onStatusChange(callback: (status: SandboxStatus) => void): () => void;

  // File Operations
  writeFile(path: string, content: string | Buffer): Promise<void>;
  writeFiles(files: Array<{path: string; content: Buffer}>): Promise<void>;
  readFile(path: string): Promise<string | null>;
  readFileBuffer(path: string): Promise<Buffer | null>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;

  // Command Execution
  runCommand(cmd: string, args?: string[], opts?: CommandOptions): Promise<CommandResult>;
  runCommandStreaming(cmd: string, args?: string[], opts?: CommandOptions): AsyncIterable<CommandOutput>;
  spawnShell(terminal: TerminalInterface): Promise<ShellProcess>;

  // Preview
  getPreviewUrl(port: number): string | null;
  onPreviewReady(callback: (port: number, url: string) => void): () => void;

  // Snapshots
  createSnapshot(): Promise<SnapshotResult>;
  restoreFromSnapshot(snapshotId: string): Promise<void>;
  extendTimeout(duration: number): Promise<void>; // No-op for WebContainer

  // Events
  onFileChange(callback: (event: FileChangeEvent) => void): () => void;
}
```

---

### 6. FileMap (Existing - Unchanged)

**Location**: `app/lib/stores/files.ts`

```typescript
interface File {
  type: 'file';
  content: string;
  isBinary: boolean;
  isLocked?: boolean;
}

interface Folder {
  type: 'folder';
  isLocked?: boolean;
}

type FileMap = Record<string, File | Folder | undefined>;
```

---

### 7. CommandOutput (New)

**Location**: `app/types/sandbox.ts`

```typescript
interface CommandOutput {
  stream: 'stdout' | 'stderr';
  data: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  sudo?: boolean; // Vercel only
}
```

---

### 8. SnapshotResult (New)

**Location**: `app/types/sandbox.ts`

```typescript
interface SnapshotResult {
  snapshotId: string;           // Local: UUID, Vercel: snap_xxx
  provider: 'local' | 'vercel';
  files: FileMap;               // Always included for backup
  createdAt: string;            // ISO timestamp
}
```

---

## Database Migration

**File**: `supabase/migrations/YYYYMMDDHHMMSS_add_sandbox_columns.sql`

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

-- Check constraints
ALTER TABLE projects
  ADD CONSTRAINT chk_sandbox_provider
  CHECK (sandbox_provider IN ('webcontainer', 'vercel'));

ALTER TABLE "user"
  ADD CONSTRAINT chk_user_sandbox_provider
  CHECK (preferred_sandbox_provider IN ('webcontainer', 'vercel'));

-- Comments
COMMENT ON COLUMN projects.sandbox_id IS 'Active Vercel Sandbox session ID';
COMMENT ON COLUMN projects.sandbox_provider IS 'Current sandbox provider for this project';
COMMENT ON COLUMN projects.sandbox_expires_at IS 'When the active sandbox session expires';
COMMENT ON COLUMN "user".preferred_sandbox_provider IS 'User preference for sandbox provider';
COMMENT ON COLUMN project_snapshots.vercel_snapshot_id IS 'Vercel Sandbox snapshot ID for fast restore';
```

---

## Indexes and Performance

| Index | Table | Columns | Purpose |
|-------|-------|---------|---------|
| `idx_projects_sandbox_id` | projects | sandbox_id | Find project by active sandbox |
| `idx_projects_user_provider` | projects | user_id, sandbox_provider | List user's projects by provider |

---

## Data Integrity Rules

1. **Sandbox session ownership**:
   - A `sandbox_id` belongs to exactly one project
   - Only the project owner can operate on the sandbox

2. **Snapshot consistency**:
   - `files` JSONB is always populated (permanent backup)
   - `vercel_snapshot_id` is optional (for fast restore)
   - If Vercel snapshot expired, fallback to `files` JSONB

3. **Provider switching**:
   - Switching providers triggers snapshot save
   - New provider loads from latest snapshot
   - Project's `sandbox_provider` updated atomically

4. **Timeout handling**:
   - `sandbox_expires_at` updated on each timeout extension
   - Background job clears stale `sandbox_id` values

---

## Volume Estimates

| Entity | Estimated Volume | Growth Rate |
|--------|------------------|-------------|
| Users | 10,000 | 500/month |
| Projects | 50,000 | 2,500/month |
| Active Sandbox Sessions | 100-500 concurrent | Varies by time of day |
| Snapshots | 50,000 (1 per project) | Matches projects |
| Vercel Sandbox Usage | ~500 sessions/day | Depends on adoption |
