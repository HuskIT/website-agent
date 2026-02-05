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

---

## 9. Live SDK Groundtruth (2026-02-05)

Everything below was captured by running `sandbox-exploration.ts` against a real
Vercel Sandbox (SDK v1.4.1, runtime `node22`).  Numbers are single-run samples;
use them as order-of-magnitude references, not benchmarks.

### 9.1 Auth

Pass `{ token, teamId, projectId }` explicitly on every static/instance call.
The SDK does **not** auto-read `VERCEL_TOKEN` from the environment — it only
auto-resolves via `VERCEL_OIDC_TOKEN` (requires `vercel link` + `vercel env pull`).
For server-side routes that already have the token, explicit creds are simplest.

```typescript
const CREDS = {
  token:     process.env.VERCEL_TOKEN!,
  teamId:    process.env.VERCEL_TEAM_ID!,
  projectId: process.env.VERCEL_PROJECT_ID!,
};
await Sandbox.create({ ...CREDS, runtime: 'node22' });
```

### 9.2 Sandbox lifecycle & timing

| Operation | Observed time | Notes |
|-----------|--------------|-------|
| `Sandbox.create()` | ~1.1 s | Status is `"pending"` immediately after |
| First command after create | works fine | SDK waits internally; no manual polling needed |
| `Sandbox.get()` reconnect | ~0.9 s | ~3× slower than docs claim (0.3 s) in practice |
| `sandbox.snapshot()` | ~7.3 s | **Stops the sandbox.** Status becomes `"snapshotting"` |
| `Sandbox.get()` after snapshot | succeeds | Returns status `"snapshotting"`, not an error |
| `Sandbox.create({ source: snapshot })` | ~1.3 s | Warm start; same speed as cold create for small images |
| `sandbox.stop()` | ~0.7 s | |
| `Sandbox.get()` after stop | **succeeds** | Returns the sandbox object (status presumably `"stopped"`). Does NOT throw. |

**Key gotcha**: `Sandbox.get()` does **not** throw after `stop()` or `snapshot()`.
You must check `sandbox.status` explicitly if you need to know whether the sandbox
is still usable.

### 9.3 File operations

```typescript
// writeFiles – batch, Buffer content required
await sandbox.writeFiles([
  { path: 'hello.txt',         content: Buffer.from('Hello') },
  { path: 'sub/nested.txt',    content: Buffer.from('Nested') },  // parent auto-created by writeFiles
]);

// readFileToBuffer – returns Buffer | null
const buf = await sandbox.readFileToBuffer({ path: 'hello.txt' });  // Buffer
const missing = await sandbox.readFileToBuffer({ path: 'nope.txt' }); // null

// readFile – docs say ReadableStream; ACTUAL return is Node.js Readable
const stream = await sandbox.readFile({ path: 'hello.txt' });
// stream.constructor.name === "Readable"
const chunks: Buffer[] = [];
for await (const chunk of stream) chunks.push(chunk);
const text = Buffer.concat(chunks).toString('utf-8');
```

**`writeFiles` auto-creates parent directories** — writing to `subdir/nested.txt`
works without calling `mkDir('subdir')` first.

#### mkDir behaviour (quirks)

- Does **NOT** support recursive creation in a single call.
  `mkDir('a/b')` fails with `file_error` if `a/` does not exist.
- Must call sequentially: `mkDir('a')` then `mkDir('a/b')`.
- Is **not idempotent**: calling `mkDir` on an existing directory throws
  `file_error: … File exists`.
- **Recommendation**: prefer `writeFiles` (which handles parents) over `mkDir`
  wherever possible.  Only use `mkDir` for empty directories you actually need.

### 9.4 Command execution

#### Blocking (default)

```typescript
const result = await sandbox.runCommand({ cmd: 'node', args: ['--version'] });
// result.exitCode  → 0
// await result.stdout()  → "v22.22.0\n"
// result.cmdId      → "cmd_c1f99d8c…"
// result.cwd        → "/vercel/sandbox"   (default working directory)
```

#### With `cwd` and `env`

```typescript
const r = await sandbox.runCommand({
  cmd: 'node',
  args: ['-e', 'console.log(process.env.MY_VAR)'],
  cwd: '/vercel/sandbox',
  env:  { MY_VAR: 'hello' },
});
// stdout → "hello\n"
```

#### Detached + `logs()` streaming

```typescript
const cmd = await sandbox.runCommand({ cmd: 'node', args: ['-e', '…'], detached: true });
// cmd.exitCode  → null  (not yet finished)

for await (const entry of cmd.logs()) {
  // entry.stream → "stdout" | "stderr"
  // entry.data   → string (may contain multiple lines in one chunk)
}

const finished = await cmd.wait();
// finished.exitCode → 0
```

**Ordering**: `logs()` does **not** guarantee interleaved stdout/stderr ordering.
In practice stderr entries can arrive *before* stdout entries even when the
process wrote stdout first.  Treat stdout and stderr as independent streams.

**Chunking**: stdout lines are often batched into a single `logs()` entry
(e.g. three `console.log` calls → one entry with `"line-1\nline-2\nline-3\n"`).
Do not assume one entry per line.

#### `output()` helper

```typescript
const r = await sandbox.runCommand({ cmd: 'node', args: ['-e', 'console.log("OUT"); console.error("ERR");'] });
await r.output('both')   // "ERR\nOUT\n"  ← stderr first, unordered
await r.output('stdout') // "OUT\n"
await r.output('stderr') // "ERR\n"
```

#### Non-zero exit & command-not-found

```typescript
// process.exit(42)
const r = await sandbox.runCommand({ cmd: 'node', args: ['-e', 'process.exit(42)'] });
r.exitCode  // 42  (does NOT throw)

// Binary not in PATH
const r2 = await sandbox.runCommand({ cmd: 'nonexistent_binary_xyz' });
r2.exitCode  // 255
await r2.stderr()
// 'time="…" level=error msg="exec failed: … executable file not found in $PATH"'
```

`runCommand` **never throws** on non-zero exit or missing binary.  Always check
`exitCode`.

#### Kill a detached command

```typescript
const cmd = await sandbox.runCommand({ cmd: '…', detached: true });
// … collect some logs …
await cmd.kill('SIGTERM');
const result = await cmd.wait();
result.exitCode  // 143  (128 + SIGTERM signal 15)
```

Signal 143 = 128 + 15 (SIGTERM).  `SIGKILL` would give 137.

#### `getCommand()` – retrieve after the fact

```typescript
const cmd = await sandbox.getCommand(cmdId);
// cmd.exitCode → populated if finished, null if still running
```

Works even after the command has exited.  Useful for reconnect scenarios.

### 9.5 sudo

```typescript
const r = await sandbox.runCommand({ cmd: 'id', sudo: true });
await r.stdout()  // "uid=0(root) gid=0(root) groups=0(root)\n"
```

`sudo: true` runs the command as root.  Default user is `vercel-sandbox`.

### 9.6 Preview URLs via `domain()`

```typescript
// Port must be declared in ports[] at creation time
const sandbox = await Sandbox.create({ ...CREDS, ports: [3000] });
sandbox.domain(3000)  // "https://sb-<hash>.vercel.run"

sandbox.domain(8080)  // throws: "No route for port 8080"
```

`domain()` is **synchronous** — no network call.  The URL is baked in at
creation.  A server must actually be listening on that port for requests to
succeed; the URL exists regardless.

### 9.7 Timeout & extendTimeout

```typescript
sandbox.timeout  // 300000  (5 min, as requested at creation)

await sandbox.extendTimeout(60_000);  // extend by 60 s

// Must re-fetch to see updated value on the same object:
const refreshed = await Sandbox.get({ ...CREDS, sandboxId: sandbox.sandboxId });
refreshed.timeout  // 360000
```

The `timeout` accessor on an existing object is **stale** after `extendTimeout`.
Always re-fetch via `Sandbox.get()` if you need the current value.

### 9.8 Sandbox.list() shape

```typescript
const { json } = await Sandbox.list({ ...CREDS, limit: 5 });
// json.sandboxes[0].sandboxId  → undefined  (not present in list summary!)
// json.sandboxes[0].status     → "running" | "stopped" | …
// json.sandboxes[0].createdAt  → number (unix ms), NOT a Date
// json.pagination              → { count: 5, next: <unix-ms>, prev: <unix-ms> }
```

**`sandboxId` is missing from list summaries.**  Use `Sandbox.list()` only for
status/time filtering.  To get a usable sandbox object you need to already know
the ID.

### 9.9 Snapshots — full lifecycle

```typescript
// 1. Create snapshot (stops the sandbox)
const snap = await sandbox.snapshot();
// snap.snapshotId      → "snap_8XBPSXP…"
// snap.sourceSandboxId → the sandbox that was snapshotted
// snap.status          → "created"
// snap.sizeBytes       → 255001189  (~255 MB for bare node22 + a few files)
// snap.createdAt       → Date
// snap.expiresAt       → Date  (7 days later)

// 2. Retrieve later
const s = await Snapshot.get({ ...CREDS, snapshotId: snap.snapshotId });

// 3. List snapshots
const { json } = await Snapshot.list({ ...CREDS, limit: 5 });
// json.snapshots[0].snapshotId  → present in list (unlike Sandbox.list)
// json.snapshots[0].createdAt   → number (unix ms)

// 4. Restore: create a new sandbox from snapshot
const restored = await Sandbox.create({
  ...CREDS,
  source:  { type: 'snapshot', snapshotId: snap.snapshotId },
  runtime: 'node22',
  timeout: 180_000,
});
// All files written before the snapshot are present in the restored sandbox.
// Directories created with mkDir are also preserved.

// 5. Delete snapshot
await snap.delete();
// Snapshot.get() after delete returns an object with status "deleted"
// (does NOT throw)
```

**Snapshot semantics**:
- Captures filesystem + installed packages.  Everything in `/vercel/sandbox`.
- The source sandbox becomes **unusable** after `snapshot()`.  Do not call
  commands on it afterwards.
- Snapshots expire after **7 days**.
- A snapshot can be used to create **multiple** sandboxes.
- Deleting a snapshot does not affect sandboxes already created from it.
- `Snapshot.get()` after deletion returns `status: "deleted"` — does not throw.

### 9.10 Corrections to existing VercelSandboxProvider

Based on the groundtruth above, the following issues exist in the current
`app/lib/sandbox/providers/vercel-sandbox.ts` and related routes:

| Issue | Location | Fix needed |
|-------|----------|------------|
| `readFile` result consumed as web `ReadableStream` | `vercel-sandbox.ts` | It is a Node.js `Readable`. Use `for await…of` or pipe. |
| `snapshot()` implemented as placeholder | `vercel-sandbox.ts` T042/T043 | SDK *does* support `sandbox.snapshot()` natively. Implement for real. |
| `mkDir` called with nested path in one shot | Any consumer | Must create parents sequentially; or skip mkDir and use `writeFiles` (auto-creates parents). |
| `Sandbox.get()` assumed to throw on stopped sandbox | `reconnect` route | It does not throw — check `status` field instead. |
| `sandbox.timeout` read after `extendTimeout` | timeout-manager | Stale — must re-fetch via `Sandbox.get()`. |
| `Sandbox.list()` result accessed as `.sandboxId` | any list consumer | `sandboxId` is `undefined` in list summary objects. |
| `Snapshot.get()` assumed to throw after `delete()` | cleanup code | Returns `{ status: "deleted" }` instead. |
