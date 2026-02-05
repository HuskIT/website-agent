# How to reconnect to a running Sandbox
Last updated February 2, 2026
By Allen ZhouAmy Burns

---

When you create a sandbox, it continues running until it times out or you explicitly stop it. If your script crashes, your connection drops, or you need to interact with the sandbox from a different process, you can reconnect using `Sandbox.get()`.

This is [different from snapshots](#key-differences:-sandbox.get-vs-snapshot.get), which save the sandbox state for later restoration. `Sandbox.get()` connects to a sandbox that is actively running.

## [Prerequisites](#prerequisites)

You need the Vercel CLI, Node.js 22+, and a [Vercel project](https://vercel.com/docs/projects) to link your sandbox and generate an OIDC token.

## [1\. Set up the project](#1.-set-up-the-project)

```
mkdir sandbox-reconnect-demo && cd sandbox-reconnect-demopnpm initpnpm add @vercel/sandbox dotenvpnpm add -D @types/nodevercel linkvercel env pull
```

This installs the SDK, links to your Vercel project, and creates `.env.local` with authentication credentials.

## [2\. Write the script](#2.-write-the-script)

Create `index.ts` with the code below. It runs in two phases:

*   Phase 1: Create a sandbox, persist its ID to disk, and exit
*   Phase 2: Load the ID, call Sandbox.get() to reconnect

```
1import { config } from 'dotenv';2config({ path: '.env.local' });3
4import { Sandbox } from '@vercel/sandbox';5import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';6
7const ID_FILE = './sandbox-id.txt';8
9async function main() {10  if (existsSync(ID_FILE)) {11    const id = readFileSync(ID_FILE, 'utf-8').trim();12    try {13      const sandbox = await Sandbox.get({ sandboxId: id });14      console.log(`Reconnected to ${sandbox.sandboxId}`);15
16      // Do work here...17
18      await sandbox.stop();19      unlinkSync(ID_FILE);20    } catch {21      unlinkSync(ID_FILE);22      await createSandbox();23    }24  } else {25    await createSandbox();26  }27}28
29async function createSandbox() {30  const sandbox = await Sandbox.create({ timeout: 10 * 60 * 1000 });31  writeFileSync(ID_FILE, sandbox.sandboxId);32  console.log(`Created ${sandbox.sandboxId}, run again to reconnect`);33}34
35main().catch(console.error);
```

### [With timing comparison](#with-timing-comparison)

To measure the speedup from reconnecting vs cold start:

```
1import { config } from 'dotenv';2config({ path: '.env.local' });3
4import { Sandbox } from '@vercel/sandbox';5import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';6
7const ID_FILE = './sandbox-id.txt';8const TIME_FILE = './cold-start.txt';9
10const read = (f: string) => readFileSync(f, 'utf-8').trim();11const write = (f: string, v: string) => writeFileSync(f, v);12const rm = (f: string) => existsSync(f) && unlinkSync(f);13
14async function main() {15  if (existsSync(ID_FILE)) {16    const id = read(ID_FILE);17    const coldMs = existsSync(TIME_FILE) ? +read(TIME_FILE) : null;18
19    try {20      const start = Date.now();21      const sandbox = await Sandbox.get({ sandboxId: id });22      const reconnectMs = Date.now() - start;23
24      console.log(`Reconnected in ${(reconnectMs / 1000).toFixed(2)}s`);25      if (coldMs) {26        console.log(`Cold: ${(coldMs / 1000).toFixed(2)}s → ` +27          `${(coldMs / reconnectMs).toFixed(1)}x faster`);28      }29      await sandbox.stop();30    } catch {31      console.log('Sandbox expired, creating new...');32    }33    rm(ID_FILE);34    rm(TIME_FILE);35  } else {36    const start = Date.now();37    const sandbox = await Sandbox.create({ timeout: 10 * 60 * 1000 });38    write(ID_FILE, sandbox.sandboxId);39    write(TIME_FILE, String(Date.now() - start));40    console.log(`Created ${sandbox.sandboxId}, run again to reconnect`);41  }42}43
44main().catch(console.error);
```

## [3\. Test it out](#3.-test-it-out)

Execute the script twice in quick succession:

```
pnpm dlx tsx index.ts
```

First execution:

```
Created sbx_abc123, run again to reconnect
```

Second execution (before the 10-minute timeout):

```
Reconnected in 0.31sCold: 2.34s → 7.5x faster
```

## [Use cases for Sandbox.get()](#use-cases-for-sandbox.get)

*   Script recovery: Reconnect after a crash without losing your running environment
*   Multi-process workflows: Access the same sandbox from different scripts or terminals
*   CLI tools: Separate sandbox lifecycle management from command execution
*   Interactive development: Keep a sandbox warm between debugging sessions

## [Handling expired sandboxes](#handling-expired-sandboxes)

If the sandbox timed out or was stopped, `Sandbox.get()` throws an error. Always wrap it in a try-catch:

```
try {  const sandbox = await Sandbox.get({ sandboxId });  console.log('Reconnected successfully');} catch (error) {  console.log('Sandbox no longer available, creating a new one...');  const sandbox = await Sandbox.create({ runtime: 'node22' });}
```

## [Performance](#performance)

| Operation | Typical Time |
| --- | --- |
| Create new sandbox | ~2-3s |
| Reconnect with `Sandbox.get()` | ~0.3s |

The ~10x speedup makes `Sandbox.get()` ideal for keeping sandboxes warm between commands.

## [Key differences: Sandbox.get() vs Snapshot.get()](#key-differences:-sandbox.get-vs-snapshot.get)

|  | Sandbox.get() | Snapshot.get() |
| --- | --- | --- |
| Target | Running sandbox | Saved state |
| Requirement | Sandbox must be active | Sandbox can be stopped |
| Persistence | Until timeout | 7 days |
| Best for | Interactive sessions | Reusable templates |

## [Next steps](#next-steps)

*   Learn about [snapshots](https://vercel.com/docs/vercel-sandbox/concepts/snapshots) for persisting sandbox state across sessions
*   See the [Sandbox SDK reference](https://vercel.com/docs/vercel-sandbox/sdk-reference) for all available methods