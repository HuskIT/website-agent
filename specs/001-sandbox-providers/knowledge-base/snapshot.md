# How to use snapshots for faster sandbox startup
Last updated February 2, 2026
By Allen ZhouAmy Burns

---

Every time you create a new sandbox, you start with a fresh environment. If your setup involves installing dependencies, cloning repositories, or building code, it can take a while. Snapshots let you save that configured state and create new sandboxes from it, skipping the setup entirely.

With snapshots, you:

1.  Set up your environment once (install dependencies, configure tools)
2.  Save the configured state as a snapshot
3.  Launch future sandboxes from that snapshot with everything already in place

Snapshots persist across sessions, so you can reuse them without repeating setup.

## [Prerequisites](#prerequisites)

Before you begin, make sure you have:

*   Vercel CLI installed (`npm install -g vercel`)
*   Node.js 22 or later
*   A [Vercel project](https://vercel.com/docs/projects) to link your sandbox and generate an OIDC token

## [1\. Project setup](#1.-project-setup)

Create a new directory and install dependencies:

```
mkdir sandbox-snapshot-democd sandbox-snapshot-demopnpm initpnpm add @vercel/sandbox dotenvpnpm add -D @types/nodevercel linkvercel env pull
```

This installs the SDK, links to your Vercel project, and creates `.env.local` with authentication credentials.

## [2\. Write the script](#2.-write-the-script)

Create `index.ts` with the code below. It runs in two modes:

*   First run: Create sandbox, install dependencies, take snapshot
*   Second run: Create sandbox from snapshot (deps already there)

```
1import { config } from 'dotenv';2config({ path: '.env.local' });3
4import { Sandbox, Snapshot } from '@vercel/sandbox';5import { writeFileSync, readFileSync, existsSync } from 'fs';6
7const ID_FILE = './snapshot-id.txt';8
9async function main() {10  if (existsSync(ID_FILE)) {11    const snapshotId = readFileSync(ID_FILE, 'utf-8').trim();12    const snapshot = await Snapshot.get({ snapshotId });13
14    const sandbox = await Sandbox.create({15      source: { type: 'snapshot', snapshotId: snapshot.snapshotId },16      timeout: 10 * 60 * 1000,17    });18    console.log(`Created from snapshot: ${sandbox.sandboxId}`);19
20    // Verify deps are pre-installed21    const result = await sandbox.runCommand({ cmd: 'ls', args: ['node_modules'] });22    const count = (await result.stdout()).split('\n').filter(Boolean).length;23    console.log(`Found ${count} packages in node_modules`);24
25    await sandbox.stop();26  } else {27    await createAndSnapshot();28  }29}30
31async function createAndSnapshot() {32  const sandbox = await Sandbox.create({ timeout: 10 * 60 * 1000 });33  console.log(`Created: ${sandbox.sandboxId}`);34
35  const deps = ['typescript', 'eslint', 'prettier', 'zod'];36  await sandbox.runCommand({37    cmd: 'npm',38    args: ['install', ...deps],39    stdout: process.stdout,40    stderr: process.stderr,41  });42
43  const snapshot = await sandbox.snapshot();44  writeFileSync(ID_FILE, snapshot.snapshotId);45  console.log(`Snapshot saved: ${snapshot.snapshotId}`);46  console.log('Run again to restore from snapshot');47}48
49main().catch(console.error);
```

### [With timing comparison](#with-timing-comparison)

To measure the speedup you get from snapshots, use the below version. It records the cold-start time on the first run, then prints the warm-start time (and savings) on the second run.

```
1import { config } from 'dotenv';2config({ path: '.env.local' });3
4import { Sandbox, Snapshot } from '@vercel/sandbox';5import { writeFileSync, readFileSync, existsSync } from 'fs';6
7const ID_FILE = './snapshot-id.txt';8const TIME_FILE = './cold-start.txt';9
10const read = (f: string) => readFileSync(f, 'utf-8').trim();11const write = (f: string, v: string) => writeFileSync(f, v);12
13async function main() {14  if (existsSync(ID_FILE)) {15    const snapshotId = read(ID_FILE);16    const coldMs = existsSync(TIME_FILE) ? +read(TIME_FILE) : null;17
18    const snapshot = await Snapshot.get({ snapshotId });19    const start = Date.now();20    const sandbox = await Sandbox.create({21      source: { type: 'snapshot', snapshotId: snapshot.snapshotId },22      timeout: 10 * 60 * 1000,23    });24    const warmMs = Date.now() - start;25
26    console.log(`Warm start: ${(warmMs / 1000).toFixed(2)}s`);27    if (coldMs) {28      console.log(`Cold start: ${(coldMs / 1000).toFixed(2)}s → ` +29        `saved ${((coldMs - warmMs) / 1000).toFixed(1)}s`);30    }31    await sandbox.stop();32  } else {33    const start = Date.now();34    const sandbox = await Sandbox.create({ timeout: 10 * 60 * 1000 });35
36    const deps = ['typescript', 'eslint', 'prettier', 'zod'];37    await sandbox.runCommand({38      cmd: 'npm',39      args: ['install', ...deps],40      stdout: process.stdout,41      stderr: process.stderr,42    });43
44    const snapshot = await sandbox.snapshot();45    write(ID_FILE, snapshot.snapshotId);46    write(TIME_FILE, String(Date.now() - start));47    console.log(`Snapshot saved, run again to restore`);48  }49}50
51main().catch(console.error);
```

## [3\. Test it out](#3.-test-it-out)

Execute the script twice:

```
pnpm dlx tsx index.ts
```

First execution:

```
Created: sbx_abc123added 88 packages in 6sSnapshot saved: snap_xyz789Run again to restore from snapshot
```

Second execution:

```
Created from snapshot: sbx_def456Found 77 packages in node_modules
```

With timing comparison enabled:

```
Warm start: 0.41sCold start: 16.49s → saved 16.1s
```

## [Key concepts](#key-concepts)

### [Taking a snapshot](#taking-a-snapshot)

Call `snapshot()` on a running sandbox to save its state:

```
const snapshot = await sandbox.snapshot();console.log(snapshot.snapshotId); // snap_abc123
```

Important: The sandbox stops automatically after snapshotting. You cannot run more commands on it.

### [Creating a sandbox from a snapshot](#creating-a-sandbox-from-a-snapshot)

Pass the snapshot ID as the source when creating a new sandbox:

```
const sandbox = await Sandbox.create({  source: { type: 'snapshot', snapshotId: snapshot.snapshotId },  timeout: 10 * 60 * 1000,});
```

### [Snapshot lifecycle](#snapshot-lifecycle)

*   You can create multiple sandboxes from the same snapshot
*   Deleting a snapshot does not affect sandboxes already created from it

For more details, see the [Snapshotting documentation](https://vercel.com/docs/vercel-sandbox/concepts/snapshots).

## [When to use snapshots vs Sandbox.get()](#when-to-use-snapshots-vs-sandbox.get)

| Scenario | Use |
| --- | --- |
| Keep sandbox warm between commands | `Sandbox.get()` |
| Reuse setup across sessions/days | Snapshot |
| Share environment with teammates | Snapshot |
| Survive sandbox timeout | Snapshot |
| Fastest possible reconnect | `Sandbox.get()` |

## [Next steps](#next-steps)

*   Learn about [Sandbox.get()](https://vercel.com/docs/vercel-sandbox/sdk-reference#sandbox.get) for reconnecting to running sandboxes
*   See the [Sandbox SDK reference](https://vercel.com/docs/vercel-sandbox/sdk-reference) for all available methods