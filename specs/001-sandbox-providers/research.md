# Research: Multi-Sandbox Provider Support

**Feature**: 001-sandbox-providers
**Date**: 2026-02-04
**Status**: Complete ✅ (All decisions implemented)

## Research Questions

1. How does Vercel Sandbox SDK compare to WebContainer API?
2. What are the best patterns for provider abstraction?
3. How to handle SSE streaming for command output?
4. How to manage file synchronization efficiently?
5. What are the timeout and session management best practices?

---

## 1. Vercel Sandbox vs WebContainer API Comparison

### Decision: Unified SandboxProvider interface with provider-specific adapters

### Rationale

Both APIs provide similar core capabilities but with different paradigms:

| Capability | WebContainer | Vercel Sandbox |
|------------|--------------|----------------|
| **Environment** | Browser (WASM) | Cloud (Firecracker microVM) |
| **Initialization** | `WebContainer.boot()` | `Sandbox.create()` |
| **File Write** | `fs.writeFile(path, content)` | `sandbox.writeFiles([{path, content}])` |
| **File Read** | `fs.readFile(path, 'utf-8')` | `sandbox.readFileToBuffer({path})` |
| **Command Exec** | `spawn(cmd, args)` | `runCommand(cmd, args)` |
| **Output Stream** | `process.output.pipeTo()` | `command.logs()` async iterator |
| **Preview URL** | `on('server-ready', (port, url))` | `sandbox.domain(port)` |
| **Snapshots** | Not native (use IndexedDB) | `sandbox.snapshot()` native |
| **Persistence** | Lost on refresh | Survives browser close |
| **Resource Usage** | High (browser memory) | Low (offloaded) |

### Alternatives Considered

1. **Direct API usage**: Each consumer uses provider-specific APIs directly
   - Rejected: Too much coupling, hard to switch providers

2. **Adapter per consumer**: ActionRunner, FilesStore each have their own adapters
   - Rejected: Code duplication, inconsistent behavior

3. **Unified interface with factory**: Single interface, factory creates provider
   - **Selected**: Clean separation, easy testing, consistent behavior

---

## 2. Provider Abstraction Pattern

### Decision: Interface + Factory pattern with lazy initialization

### Rationale

Follows the existing LLM provider pattern in `app/lib/modules/llm/`:

```typescript
// SandboxProvider interface
interface SandboxProvider {
  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readonly status: SandboxStatus;
  readonly type: 'webcontainer' | 'vercel';

  // File operations
  writeFile(path: string, content: string | Buffer): Promise<void>;
  writeFiles(files: Array<{path: string; content: Buffer}>): Promise<void>;
  readFile(path: string): Promise<string | null>;
  mkdir(path: string): Promise<void>;

  // Command execution
  runCommand(cmd: string, args?: string[], opts?: CommandOptions): Promise<CommandResult>;
  runCommandStreaming(cmd: string, args?: string[], opts?: CommandOptions): AsyncIterable<CommandOutput>;

  // Preview
  getPreviewUrl(port: number): string | null;
  onPreviewReady(callback: (port: number, url: string) => void): () => void;

  // Snapshots
  createSnapshot(): Promise<string>; // Returns snapshot ID
  restoreFromSnapshot(snapshotId: string): Promise<void>;

  // Events
  onStatusChange(callback: (status: SandboxStatus) => void): () => void;
  onFileChange(callback: (event: FileChangeEvent) => void): () => void;
}
```

### Factory Pattern

```typescript
// sandbox-factory.ts
export function createSandboxProvider(
  type: 'webcontainer' | 'vercel',
  config: SandboxConfig
): SandboxProvider {
  switch (type) {
    case 'webcontainer':
      return new WebContainerProvider(config);
    case 'vercel':
      return new VercelSandboxProvider(config);
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}
```

### Alternatives Considered

1. **Class inheritance**: Abstract base class with provider subclasses
   - Rejected: TypeScript interfaces preferred, easier to mock

2. **Strategy pattern**: Inject strategy at runtime
   - Rejected: Similar to factory but more complex for this use case

---

## 3. SSE Streaming for Command Output

### Decision: Use AsyncIterable pattern with server-sent events for cloud provider

### Rationale

**WebContainer (local)**:
- Already uses `WritableStream` for output
- Direct access to `process.output.pipeTo()`

**Vercel Sandbox (cloud)**:
- Native `command.logs()` returns `AsyncGenerator<{stream, data}>`
- Must proxy through server to hide credentials
- SSE is the established pattern for streaming in the codebase

### Implementation Pattern

```typescript
// Server route: api.sandbox.command.ts
export async function action({ request }: ActionFunctionArgs) {
  const { sandboxId, cmd, args } = await request.json();
  const sandbox = await Sandbox.get({ sandboxId });

  const stream = new ReadableStream({
    async start(controller) {
      const command = await sandbox.runCommand({ cmd, args, detached: true });

      for await (const log of command.logs()) {
        const event = `data: ${JSON.stringify(log)}\n\n`;
        controller.enqueue(new TextEncoder().encode(event));
      }

      const result = await command.wait();
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ exitCode: result.exitCode })}\n\n`)
      );
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// Client: VercelSandboxProvider
async *runCommandStreaming(cmd: string, args?: string[]): AsyncIterable<CommandOutput> {
  const response = await fetch('/api/sandbox/command', {
    method: 'POST',
    body: JSON.stringify({ sandboxId: this.sandboxId, cmd, args }),
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        yield JSON.parse(line.slice(6));
      }
    }
  }
}
```

---

## 4. File Synchronization Strategy

### Decision: Incremental sync with change tracking and batch writes

### Rationale

**Requirements**:
- Only sync changed files (FR-004)
- Handle both directions: Editor → Provider, Provider → UI
- Support binary files

**WebContainer (local)**:
- Direct writes to `webcontainer.fs`
- File watcher for Provider → UI sync
- Already tracks `#recentlySavedFiles` to prevent loops

**Vercel Sandbox (cloud)**:
- Batch writes via `sandbox.writeFiles([...])` (reduces API calls)
- No native file watching; must poll or use heartbeat
- Read files on demand for Editor → UI sync

### Implementation Pattern

```typescript
// file-sync.ts
export class FileSyncManager {
  #pendingWrites = new Map<string, { content: Buffer; debounceTimer: number }>();
  #syncedHashes = new Map<string, string>();

  async queueWrite(path: string, content: string | Buffer): Promise<void> {
    const buffer = typeof content === 'string' ? Buffer.from(content) : content;
    const hash = this.#computeHash(buffer);

    // Skip if unchanged
    if (this.#syncedHashes.get(path) === hash) return;

    // Debounce writes (100ms)
    const existing = this.#pendingWrites.get(path);
    if (existing) clearTimeout(existing.debounceTimer);

    const debounceTimer = setTimeout(() => this.#flush(), 100);
    this.#pendingWrites.set(path, { content: buffer, debounceTimer });
  }

  async #flush(): Promise<void> {
    const files = Array.from(this.#pendingWrites.entries()).map(([path, { content }]) => ({
      path,
      content,
    }));

    if (files.length === 0) return;

    await this.#provider.writeFiles(files);

    for (const { path, content } of files) {
      this.#syncedHashes.set(path, this.#computeHash(content));
    }

    this.#pendingWrites.clear();
  }
}
```

---

## 5. Timeout and Session Management

### Decision: Activity-based timeout extension with predictive snapshot

### Rationale

**Vercel Sandbox Constraints**:
- Default timeout: 5 minutes
- Can extend via `sandbox.extendTimeout(duration)`
- Max timeout: 45 min (Hobby) / 5 hr (Pro/Enterprise)
- Snapshot stops the sandbox (cannot continue after)

**Activity Detection**:
- Track last user activity (keystroke, save, command)
- Extend timeout if activity within threshold (5 min)
- Auto-snapshot when no activity detected before timeout

### Implementation Pattern

```typescript
// timeout-manager.ts
export class TimeoutManager {
  #lastActivity = Date.now();
  #timeoutWarningThreshold = 2 * 60 * 1000; // 2 minutes
  #activityThreshold = 5 * 60 * 1000; // 5 minutes
  #checkInterval: number | null = null;

  constructor(
    private sandbox: SandboxProvider,
    private onTimeoutWarning: () => void,
    private onAutoSnapshot: () => Promise<void>
  ) {}

  start(): void {
    this.#checkInterval = setInterval(() => this.#check(), 30_000);
  }

  recordActivity(): void {
    this.#lastActivity = Date.now();
  }

  async #check(): Promise<void> {
    const sandbox = await this.sandbox.getStatus();
    if (sandbox.type !== 'vercel') return;

    const timeRemaining = sandbox.timeout;
    const timeSinceActivity = Date.now() - this.#lastActivity;

    // Warn if approaching timeout
    if (timeRemaining < this.#timeoutWarningThreshold) {
      this.onTimeoutWarning();

      // Extend if recent activity
      if (timeSinceActivity < this.#activityThreshold) {
        await this.sandbox.extendTimeout(5 * 60 * 1000); // +5 minutes
      } else {
        // No activity, trigger snapshot
        await this.onAutoSnapshot();
      }
    }
  }

  stop(): void {
    if (this.#checkInterval) {
      clearInterval(this.#checkInterval);
    }
  }
}
```

---

## 6. Server-Side API Route Design

### Decision: RESTful routes with SSE for streaming, Zod validation

### Rationale

Follows existing API patterns (`api.projects.*`, `api.crawler.*`):
- Auth via `requireSessionOrError()`
- Zod schemas for input validation
- SSE for streaming responses
- JSON for simple request/response

### Route Structure

| Route | Method | Purpose | Streaming |
|-------|--------|---------|-----------|
| `/api/sandbox/create` | POST | Create new sandbox | No |
| `/api/sandbox/reconnect` | POST | Reconnect to existing | No |
| `/api/sandbox/files` | POST | Write files (batch) | No |
| `/api/sandbox/files/:path` | GET | Read single file | No |
| `/api/sandbox/command` | POST | Execute command | Yes (SSE) |
| `/api/sandbox/snapshot` | POST | Create snapshot | No |
| `/api/sandbox/snapshot/:id` | POST | Restore from snapshot | No |
| `/api/sandbox/status` | GET | Get sandbox status | No |
| `/api/sandbox/extend` | POST | Extend timeout | No |

### Auth & Ownership

```typescript
// All routes require:
const session = await requireSessionOrError(request);

// For sandbox operations:
const project = await getProjectById(projectId, session.user.id);
if (!project) throw new Response('Project not found', { status: 404 });

// Verify sandbox ownership
if (project.sandbox_id !== sandboxId) {
  throw new Response('Sandbox not owned by project', { status: 403 });
}
```

---

## 7. Database Schema Changes

### Decision: Add sandbox columns to existing tables

### Rationale

Minimal schema change, consistent with existing patterns:

```sql
-- Migration: add_sandbox_columns
ALTER TABLE projects
  ADD COLUMN sandbox_id TEXT,
  ADD COLUMN sandbox_provider TEXT DEFAULT 'vercel',
  ADD COLUMN sandbox_expires_at TIMESTAMPTZ;

ALTER TABLE "user"
  ADD COLUMN preferred_sandbox_provider TEXT DEFAULT 'vercel';

-- Index for quick lookup
CREATE INDEX idx_projects_sandbox_id ON projects(sandbox_id) WHERE sandbox_id IS NOT NULL;
```

---

## 8. Feature Flag Strategy

### Decision: Environment variable + user override

### Rationale

Allow gradual rollout and fallback:

```typescript
// Environment level
SANDBOX_PROVIDER_DEFAULT=vercel  // 'webcontainer' | 'vercel'
SANDBOX_VERCEL_ENABLED=true      // Kill switch

// User level override
user.preferred_sandbox_provider  // null = use default

// Resolution
function resolveProvider(user: User): 'webcontainer' | 'vercel' {
  if (!process.env.SANDBOX_VERCEL_ENABLED) return 'webcontainer';
  return user.preferred_sandbox_provider ?? process.env.SANDBOX_PROVIDER_DEFAULT ?? 'vercel';
}
```

---

## Summary

| Question | Decision | Implementation |
|----------|----------|----------------|
| API comparison | Unified SandboxProvider interface | ✅ `app/lib/sandbox/types.ts` |
| Abstraction pattern | Interface + Factory with lazy init | ✅ `app/lib/sandbox/index.ts` |
| Command streaming | SSE for cloud, WritableStream for local | ✅ `api.sandbox.command.ts` |
| File sync | Incremental with debounced batch writes | ✅ `app/lib/sandbox/file-sync.ts` |
| Timeout management | Activity-based extension, predictive snapshot | ✅ `app/lib/sandbox/timeout-manager.ts` |
| API routes | RESTful + SSE, Zod validation | ✅ 10 routes in `app/routes/api.sandbox.*` |
| Schema | Add columns to projects + user tables | ✅ `supabase/migrations/20260204223702_add_sandbox_columns.sql` |
| Feature flag | Env default + user override | ✅ `SANDBOX_VERCEL_ENABLED`, `SANDBOX_PROVIDER_DEFAULT` |

All research questions resolved and implemented.
