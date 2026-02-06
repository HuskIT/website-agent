# Vercel Sandbox — SDK Reference

> Last fetched: 2026-02-06
> Source: https://vercel.com/docs/vercel-sandbox/sdk-reference

## Install

```bash
pnpm i @vercel/sandbox
```

After install: `vercel link` + `vercel env pull` for OIDC auth.
Runtimes: `node24`, `node22`, `python3.13`.

## Core classes

| Class | Purpose |
|-------|---------|
| `Sandbox` | Create/manage isolated microVMs |
| `Command` | Handle running commands |
| `CommandFinished` | Result after command completes |
| `Snapshot` | Saved sandbox state for fast restarts |

---

## Sandbox class

### Accessors

| Accessor | Returns | Description |
|----------|---------|-------------|
| `sandboxId` | `string` | Unique ID — use with `Sandbox.get()` to reconnect |
| `status` | `"pending" \| "running" \| "stopping" \| "stopped" \| "failed"` | Lifecycle state |
| `timeout` | `number` | Milliseconds remaining before auto-stop |
| `createdAt` | `Date` | When sandbox was created |

### Static methods

#### `Sandbox.create(opts?)`

Creates new microVM. Returns `Promise<Sandbox>`.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `source` (git) | `{ type: 'git', url, username?, password?, depth?, revision? }` | No | Clone a repo |
| `source` (tarball) | `{ type: 'tarball', url }` | No | Mount tarball |
| `source` (snapshot) | `{ type: 'snapshot', snapshotId }` | No | From snapshot |
| `resources.vcpus` | `number` | No | CPU count |
| `runtime` | `string` | No | `"node24"`, `"node22"`, `"python3.13"` |
| `ports` | `number[]` | No | Ports to expose |
| `timeout` | `number` | No | Initial timeout (ms) |
| `signal` | `AbortSignal` | No | Cancel creation |

```ts
const sandbox = await Sandbox.create({ runtime: 'node24', ports: [3000] });
```

#### `Sandbox.get({ sandboxId, signal? })`

Rehydrate active sandbox by ID. Returns `Promise<Sandbox>`. Throws if sandbox no longer exists.

#### `Sandbox.list({ projectId, limit?, since?, until?, signal? })`

List sandboxes for a project with optional time range/pagination. Returns sandboxes array + pagination cursor.

### Instance methods

#### `sandbox.runCommand(cmd, args?, opts?)`

Execute command inside the microVM.

**Object overload params:**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `cmd` | `string` | Yes | Command to run |
| `args` | `string[]` | No | Arguments |
| `cwd` | `string` | No | Working directory |
| `env` | `Record<string, string>` | No | Extra env vars |
| `sudo` | `boolean` | No | Run with sudo |
| `detached` | `boolean` | No | Return immediately with live `Command` |
| `stdout` | `Writable` | No | Stream stdout |
| `stderr` | `Writable` | No | Stream stderr |
| `signal` | `AbortSignal` | No | Cancel |

Returns `Promise<CommandFinished>` (blocking) or `Promise<Command>` (detached).

```ts
// Blocking
const result = await sandbox.runCommand('node', ['--version']);
console.log(await result.stdout());

// Detached (for servers)
const server = await sandbox.runCommand({ cmd: 'npm', args: ['start'], detached: true });
```

#### `sandbox.writeFiles(files, opts?)`

Upload files. Paths relative to `/vercel/sandbox`.

```ts
await sandbox.writeFiles([{ path: 'hello.txt', content: Buffer.from('hi') }]);
```

#### `sandbox.readFile({ path, cwd? }, opts?)`

Returns `Promise<ReadableStream | null>`.

#### `sandbox.readFileToBuffer({ path, cwd? }, opts?)`

Returns `Promise<Buffer | null>`.

#### `sandbox.downloadFile(src, dst, opts?)`

Download file from sandbox to local path. Returns `Promise<string | null>`.

#### `sandbox.mkDir(path, opts?)`

Create directory in sandbox. Relative to `/vercel/sandbox`.

#### `sandbox.domain(port)`

Get public URL for an exposed port. Port must be in `ports` array from creation.

```ts
const url = sandbox.domain(3000); // Returns public URL string
```

#### `sandbox.stop(opts?)`

Terminate microVM immediately. Safe to call multiple times.

#### `sandbox.extendTimeout(duration, opts?)`

Extend lifetime by `duration` ms. Max: 45min (Hobby), 5h (Pro/Enterprise).

#### `sandbox.snapshot(opts?)`

Capture current state (filesystem, packages). **Sandbox stops after snapshot.**
Returns `Promise<Snapshot>`. Snapshots expire after 7 days.

```ts
const snapshot = await sandbox.snapshot();
// Later:
const newSandbox = await Sandbox.create({
  source: { type: 'snapshot', snapshotId: snapshot.snapshotId }
});
```

#### `sandbox.getCommand(cmdId, opts?)`

Retrieve previously executed command by ID.

---

## Command class

Represents running processes. Returned by detached `runCommand()`.

### Properties/Accessors

| Name | Returns | Notes |
|------|---------|-------|
| `exitCode` | `number \| null` | `null` while running |
| `cmdId` | `string` | Unique command ID |
| `cwd` | `string` | Working directory |
| `startedAt` | `number` | Unix timestamp (ms) |

### Methods

#### `command.logs(opts?)`

Stream structured log entries. Returns `AsyncGenerator<{ stream: "stdout" | "stderr", data: string }>`.

```ts
for await (const log of command.logs()) {
  process.stdout.write(log.data);
}
```

#### `command.wait(opts?)`

Block until detached command finishes. Returns `Promise<CommandFinished>`.

#### `command.output(stream, opts?)`

Get stdout, stderr, or both as string. `stream`: `"stdout" | "stderr" | "both"`.

#### `command.stdout(opts?)` / `command.stderr(opts?)`

Convenience methods returning `Promise<string>`.

#### `command.kill(signal?, opts?)`

Send signal to process. Default `SIGTERM`, use `SIGKILL` for immediate.

---

## CommandFinished class

Extends `Command` with guaranteed `exitCode: number` (not null). Returned by blocking `runCommand()` or `command.wait()`. Has all Command methods.

---

## Snapshot class

### Accessors

| Name | Returns |
|------|---------|
| `snapshotId` | `string` |
| `sourceSandboxId` | `string` |
| `status` | `"created" \| "deleted" \| "failed"` |

### Static methods

#### `Snapshot.get({ snapshotId, signal? })`

Retrieve existing snapshot by ID.

### Instance methods

#### `snapshot.delete(opts?)`

Remove snapshot. Helps manage storage.

---

## Environment defaults

- **OS**: Amazon Linux 2023 with git, tar, openssl, dnf
- **Runtimes**: `node24`, `node22`, `python3.13` with respective package managers
- **Default timeout**: 5 minutes
- **Max timeout**: 45 min (Hobby), 5 hours (Pro/Enterprise)
- **Sudo**: Commands run as `vercel-sandbox` with root home at `/root`
- **Filesystem**: Ephemeral — export artifacts before stopping
- **Working dir**: `/vercel/sandbox`
- **User**: `vercel-sandbox`
