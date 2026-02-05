# Sandbox Provider Validation Checklist

## Phase 1-2: Foundation ✅

- [x] Directory structure created at `app/lib/sandbox/`
- [x] `@vercel/sandbox` dependency installed
- [x] Database migration for sandbox columns
- [x] Environment variables in `.env.example`

## Phase 3: US1 - Fast Preview Updates ✅

### API Routes
- [x] `POST /api/sandbox/create` - Creates sandbox, stores sandboxId on project
- [x] `POST /api/sandbox/files` - Batch file writes
- [x] `GET /api/sandbox/files/:path` - Read single file
- [x] `POST /api/sandbox/command` - SSE streaming command execution

### Provider Implementation
- [x] `VercelSandboxProvider` implements `SandboxProvider` interface
- [x] `WebContainerProvider` refactored to use interface
- [x] `FileSyncManager` handles batching/debouncing

### Store Integration
- [x] `FilesStore` syncs via `FileSyncManager`
- [x] `PreviewsStore` handles both URL types
- [x] `WorkbenchStore.initializeProvider()` wires everything

## Phase 4: US2 - Session Persistence ✅

### API Routes
- [x] `POST /api/sandbox/reconnect` - Reconnect to existing sandbox
- [x] `GET /api/sandbox/status` - Get sandbox status
- [x] `POST /api/sandbox/extend` - Extend timeout
- [x] `POST /api/sandbox/stop` - Stop sandbox

### Implementation
- [x] `TimeoutManager` with activity tracking
- [x] `VercelSandboxProvider.reconnect()` method
- [x] Project record stores `sandboxId`, `sandboxProvider`, `sandboxExpiresAt`
- [x] `WorkbenchStore.reconnectOrRestore()` for session restoration
- [x] `TimeoutWarning` UI component
- [x] Integrated into `Workbench.client.tsx`

## Manual Test Script

### Test 1: Sandbox Creation
```bash
# Prerequisites: User authenticated, project exists

# 1. Create sandbox
curl -X POST http://localhost:5171/api/sandbox/create \
  -H "Content-Type: application/json" \
  -H "Cookie: your_session_cookie" \
  -d '{
    "projectId": "your-project-uuid",
    "runtime": "node22",
    "ports": [3000, 5173, 8080],
    "timeout": 300000
  }'

# Expected response:
# {
#   "sandboxId": "sb_...",
#   "status": "running",
#   "previewUrls": { "3000": "https://...", ... },
#   "timeout": 300000,
#   "createdAt": "..."
# }
```

### Test 2: File Operations
```bash
# Write files
curl -X POST http://localhost:5171/api/sandbox/files \
  -H "Content-Type: application/json" \
  -H "Cookie: your_session_cookie" \
  -d '{
    "projectId": "your-project-uuid",
    "sandboxId": "sb_...",
    "files": [
      { "path": "test.txt", "content": "Hello World", "encoding": "utf8" }
    ]
  }'

# Read file
curl "http://localhost:5171/api/sandbox/files/test.txt?projectId=...&sandboxId=..." \
  -H "Cookie: your_session_cookie"
```

### Test 3: Command Execution
```bash
# Execute command with SSE streaming
curl -X POST http://localhost:5171/api/sandbox/command \
  -H "Content-Type: application/json" \
  -H "Cookie: your_session_cookie" \
  -d '{
    "projectId": "your-project-uuid",
    "sandboxId": "sb_...",
    "cmd": "echo",
    "args": ["hello"],
    "timeout": 30000
  }'

# Expected: SSE stream with output and exit event
```

### Test 4: Session Persistence
```bash
# Get status
curl "http://localhost:5171/api/sandbox/status?projectId=...&sandboxId=..." \
  -H "Cookie: your_session_cookie"

# Extend timeout
curl -X POST http://localhost:5171/api/sandbox/extend \
  -H "Content-Type: application/json" \
  -H "Cookie: your_session_cookie" \
  -d '{
    "projectId": "your-project-uuid",
    "sandboxId": "sb_...",
    "duration": 300000
  }'

# Reconnect (for existing sandbox)
curl -X POST http://localhost:5171/api/sandbox/reconnect \
  -H "Content-Type: application/json" \
  -H "Cookie: your_session_cookie" \
  -d '{
    "projectId": "your-project-uuid",
    "sandboxId": "sb_...",
    "ports": [3000, 5173, 8080]
  }'

# Stop sandbox
curl -X POST http://localhost:5171/api/sandbox/stop \
  -H "Content-Type: application/json" \
  -H "Cookie: your_session_cookie" \
  -d '{
    "projectId": "your-project-uuid",
    "sandboxId": "sb_...",
    "createSnapshot": false
  }'
```

### Test 5: Client-Side Integration

```typescript
// In browser console

// 1. Initialize provider
const provider = await workbenchStore.initializeProvider(
  'vercel',
  'project-id',
  'user-id'
);

// 2. Check sandbox ID
console.log(workbenchStore.sandboxProvider?.sandboxId);

// 3. Record activity
workbenchStore.recordActivity('file_write');

// 4. Check timeout manager
console.log(workbenchStore.timeoutManager?.getState());

// 5. Test reconnectOrRestore
const result = await workbenchStore.reconnectOrRestore(
  'project-id',
  'user-id',
  'sandbox-id',
  'vercel'
);
console.log(result); // { success: true, provider: ..., restored: true }
```

## Expected Behaviors

### Timeout Warning
1. After 3 minutes (with 5-minute timeout), warning toast appears
2. Toast shows time remaining with progress bar
3. "Extend Session" button calls `/api/sandbox/extend`
4. Dismiss button hides warning

### Auto-Extension
1. User performs 3+ file saves/commands within 1 minute
2. Time remaining drops below 4 minutes
3. Auto-extend triggers (adds 5 minutes)
4. Activity stops being recorded after session expires

### Session Reconnection
1. User refreshes page with active Vercel sandbox
2. `reconnectOrRestore()` checks `project.sandboxId`
3. Calls `provider.reconnect(sandboxId)`
4. If successful: restored to existing session
5. If failed: creates new sandbox

## Troubleshooting

### "Vercel Sandbox is disabled"
- Check `SANDBOX_VERCEL_ENABLED` env var is not `false`

### "Authentication required"
- Ensure user is logged in
- Check session cookie is being sent

### "Sandbox not found"
- Sandbox may have expired (5-minute default)
- Vercel project/team IDs may be incorrect

### TypeScript Errors
- Run `pnpm install` to ensure `@vercel/sandbox` is installed
- Check `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TOKEN` are set
