/**
 * sandbox-exploration.ts
 *
 * Isolated, sequential exploration script for the Vercel Sandbox SDK.
 * Each section is clearly labelled, timed, and outputs raw responses
 * so we can capture real groundtruth data for research.md.
 *
 * Run: npx tsx specs/001-sandbox-providers/knowledge-base/sandbox-exploration.ts
 *
 * State files written to /tmp/sandbox-exploration/ so nothing pollutes the repo.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { Sandbox, Snapshot } from '@vercel/sandbox';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';

// ─── Auth credentials (explicit, no OIDC needed) ────────────────────────────
const CREDS = {
  token:     process.env.VERCEL_TOKEN!,
  teamId:    process.env.VERCEL_TEAM_ID!,
  projectId: process.env.VERCEL_PROJECT_ID!,
};

// ─── State directory ─────────────────────────────────────────────────────────
const STATE_DIR = '/tmp/sandbox-exploration';
mkdirSync(STATE_DIR, { recursive: true });
const stateFile = (name: string) => `${STATE_DIR}/${name}`;
const saveState  = (name: string, data: unknown) =>
  writeFileSync(stateFile(name), JSON.stringify(data, null, 2));
const loadState  = <T>(name: string): T | null => {
  try { return JSON.parse(readFileSync(stateFile(name), 'utf-8')); }
  catch { return null; }
};

// ─── Logging helpers ─────────────────────────────────────────────────────────
let currentSection = '';
function section(title: string) {
  currentSection = title;
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(72)}`);
}
function log(label: string, value: unknown) {
  console.log(`  [${currentSection}] ${label}:`, value);
}
function logRaw(label: string, value: unknown) {
  console.log(`  [${currentSection}] ${label}:`);
  console.log(JSON.stringify(value, null, 4));
}

// ─── Timer utility ───────────────────────────────────────────────────────────
function timer() {
  const start = Date.now();
  return { elapsed: () => `${((Date.now() - start) / 1000).toFixed(2)}s` };
}

// ─── Determine which phase to run ───────────────────────────────────────────
// We use state files so we can run this script multiple times and it
// picks up where it left off.  Delete /tmp/sandbox-exploration to restart.
//
// Phase A: Create sandbox, exercise file/command/status/timeout, snapshot it, stop
// Phase B: Restore from snapshot, verify files survived, exercise kill/list, cleanup

async function main() {
  section('PRE-CHECK');
  log('VERCEL_TOKEN',     CREDS.token ? `${CREDS.token.slice(0,8)}…` : 'MISSING');
  log('VERCEL_TEAM_ID',   CREDS.teamId  || 'MISSING');
  log('VERCEL_PROJECT_ID', CREDS.projectId || 'MISSING');

  if (!CREDS.token || !CREDS.teamId || !CREDS.projectId) {
    console.error('\n  ❌ Missing credentials. Check .env.local');
    process.exit(1);
  }

  const snapshotId = loadState<string>('snapshotId');

  if (!snapshotId) {
    await phaseA();
  } else {
    await phaseB(snapshotId);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE A – Create, use, snapshot, stop
// ══════════════════════════════════════════════════════════════════════════════
async function phaseA() {
  // ── A1: Create sandbox ─────────────────────────────────────────────────────
  section('A1 – Sandbox.create()');
  const t1 = timer();
  const sandbox = await Sandbox.create({
    ...CREDS,
    runtime: 'node22',
    timeout: 5 * 60 * 1000,   // 5 min
    ports:   [3000],            // expose port 3000 for later domain() check
  });
  log('elapsed',      t1.elapsed());
  log('sandboxId',    sandbox.sandboxId);
  log('status',       sandbox.status);
  log('timeout (ms)', sandbox.timeout);
  log('createdAt',    sandbox.createdAt);
  saveState('sandboxId', sandbox.sandboxId);

  // ── A2: Check status & accessors immediately ──────────────────────────────
  section('A2 – Status & accessors');
  log('sandboxId',    sandbox.sandboxId);
  log('status',       sandbox.status);
  log('timeout (ms)', sandbox.timeout);
  log('createdAt',    sandbox.createdAt.toISOString());

  // ── A3: Sandbox.get() – reconnect to same sandbox ─────────────────────────
  section('A3 – Sandbox.get() reconnect');
  const t3 = timer();
  const reconnected = await Sandbox.get({ ...CREDS, sandboxId: sandbox.sandboxId });
  log('elapsed',   t3.elapsed());
  log('sandboxId', reconnected.sandboxId);
  log('status',    reconnected.status);
  log('timeout',   reconnected.timeout);

  // ── A4: writeFiles ─────────────────────────────────────────────────────────
  section('A4 – sandbox.writeFiles()');
  const t4 = timer();
  await sandbox.writeFiles([
    { path: 'hello.txt',        content: Buffer.from('Hello from Vercel Sandbox!') },
    { path: 'data.json',        content: Buffer.from(JSON.stringify({ key: 'value', ts: Date.now() })) },
    { path: 'subdir/nested.txt', content: Buffer.from('I am nested') },
  ]);
  log('elapsed', t4.elapsed());
  log('wrote',   'hello.txt, data.json, subdir/nested.txt');

  // ── A5: readFileToBuffer ───────────────────────────────────────────────────
  section('A5 – sandbox.readFileToBuffer()');
  const t5 = timer();
  const buf = await sandbox.readFileToBuffer({ path: 'hello.txt' });
  log('elapsed',  t5.elapsed());
  log('content',  buf ? buf.toString('utf-8') : null);

  // Read non-existent file
  const bufMissing = await sandbox.readFileToBuffer({ path: 'does-not-exist.txt' });
  log('missing file result', bufMissing);

  // ── A6: readFile (stream) ──────────────────────────────────────────────────
  // NOTE: Despite docs saying ReadableStream, SDK v1.4.1 returns Node.js Readable
  section('A6 – sandbox.readFile() → Node Readable (NOT web ReadableStream)');
  const stream = await sandbox.readFile({ path: 'data.json' });
  if (stream) {
    log('stream constructor', (stream as any).constructor?.name);  // "Readable"
    const chunks: Buffer[] = [];
    for await (const chunk of stream as any) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    log('streamed content', Buffer.concat(chunks).toString('utf-8'));
  } else {
    log('stream', null);
  }

  // ── A7: runCommand – blocking (simple) ─────────────────────────────────────
  section('A7 – runCommand() blocking – node --version');
  const t7 = timer();
  const nodeVer = await sandbox.runCommand({ cmd: 'node', args: ['--version'] });
  log('elapsed',  t7.elapsed());
  log('exitCode', nodeVer.exitCode);
  log('stdout',   await nodeVer.stdout());
  log('cmdId',    nodeVer.cmdId);
  log('cwd',      nodeVer.cwd);
  log('startedAt', nodeVer.startedAt);

  // ── A8: runCommand – with cwd and env ──────────────────────────────────────
  section('A8 – runCommand() with cwd & env');
  const envResult = await sandbox.runCommand({
    cmd: 'node',
    args: ['-e', 'console.log(JSON.stringify({ cwd: process.cwd(), myVar: process.env.MY_VAR }))'],
    cwd: '/vercel/sandbox',
    env:  { MY_VAR: 'exploration-test-42' },
  });
  log('exitCode', envResult.exitCode);
  log('stdout',   await envResult.stdout());

  // ── A9: runCommand – detached + logs() streaming ──────────────────────────
  section('A9 – runCommand() detached + logs() stream');
  const detached = await sandbox.runCommand({
    cmd:      'node',
    args:     ['-e', `
      async function run() {
        console.log('line-1: start');
        await new Promise(r => setTimeout(r, 200));
        console.log('line-2: middle');
        await new Promise(r => setTimeout(r, 200));
        console.log('line-3: end');
        console.error('err-1: this is stderr');
      }
      run();
    `],
    detached: true,
  });
  log('cmdId (detached)', detached.cmdId);
  log('exitCode before wait', detached.exitCode);  // should be null

  const collected: { stream: string; data: string }[] = [];
  for await (const entry of detached.logs()) {
    collected.push(entry);
    console.log(`    → [${entry.stream}] ${entry.data.trimEnd()}`);
  }
  logRaw('all log entries', collected);

  const finished = await detached.wait();
  log('exitCode after wait', finished.exitCode);
  log('stdout (after wait)', await finished.stdout());
  log('stderr (after wait)', await finished.stderr());

  // ── A10: runCommand – exit code != 0 ──────────────────────────────────────
  section('A10 – runCommand() non-zero exit');
  const failCmd = await sandbox.runCommand({ cmd: 'node', args: ['-e', 'process.exit(42)'] });
  log('exitCode', failCmd.exitCode);
  log('stdout',   await failCmd.stdout());
  log('stderr',   await failCmd.stderr());

  // ── A11: runCommand – command not found ────────────────────────────────────
  section('A11 – runCommand() command-not-found');
  try {
    const nope = await sandbox.runCommand({ cmd: 'nonexistent_binary_xyz', args: [] });
    log('exitCode', nope.exitCode);
    log('stdout',   await nope.stdout());
    log('stderr',   await nope.stderr());
  } catch (err: unknown) {
    log('THREW', (err as Error).message);
  }

  // ── A12: mkDir ─────────────────────────────────────────────────────────────
  section('A12 – sandbox.mkDir()');
  await sandbox.mkDir('created-dir/sub');
  const lsDir = await sandbox.runCommand({ cmd: 'ls', args: ['-la', 'created-dir'] });
  log('exitCode', lsDir.exitCode);
  log('ls output', await lsDir.stdout());

  // ── A13: domain() – get preview URL ──────────────────────────────────────
  section('A13 – sandbox.domain()');
  try {
    const url = sandbox.domain(3000);
    log('domain(3000)', url);
  } catch (err: unknown) {
    log('domain() threw', (err as Error).message);
  }

  // ── A14: extendTimeout ─────────────────────────────────────────────────────
  section('A14 – sandbox.extendTimeout()');
  log('timeout BEFORE extend', sandbox.timeout);
  await sandbox.extendTimeout(60_000);  // +60 seconds
  // Re-fetch to see updated value
  const afterExtend = await Sandbox.get({ ...CREDS, sandboxId: sandbox.sandboxId });
  log('timeout AFTER extend (re-fetched)', afterExtend.timeout);

  // ── A15: Sandbox.list() ────────────────────────────────────────────────────
  section('A15 – Sandbox.list()');
  const listed = await Sandbox.list({ ...CREDS, limit: 5 });
  logRaw('sandboxes (first 5)', listed.json.sandboxes.map((s: any) => ({
    sandboxId: s.sandboxId,
    status:    s.status,
    createdAt: s.createdAt,
  })));
  log('pagination', listed.json.pagination);

  // ── A16: snapshot() ────────────────────────────────────────────────────────
  // IMPORTANT: snapshot() stops the sandbox. Do this last before phaseA ends.
  section('A16 – sandbox.snapshot()');
  const t16 = timer();
  const snap = await sandbox.snapshot();
  log('elapsed',         t16.elapsed());
  log('snapshotId',      snap.snapshotId);
  log('sourceSandboxId', snap.sourceSandboxId);
  log('status',          snap.status);
  log('sizeBytes',       snap.sizeBytes);
  log('createdAt',       snap.createdAt);
  log('expiresAt',       snap.expiresAt);

  saveState('snapshotId', snap.snapshotId);

  // Verify sandbox is now stopped after snapshot
  section('A16b – Verify sandbox stopped after snapshot');
  try {
    const afterSnap = await Sandbox.get({ ...CREDS, sandboxId: sandbox.sandboxId });
    log('status after snapshot', afterSnap.status);
  } catch (err: unknown) {
    log('Sandbox.get() threw (expected)', (err as Error).message);
  }

  console.log('\n  ✅ Phase A complete. Run the script again for Phase B (restore from snapshot).');
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE B – Restore from snapshot, verify, kill, list, cleanup
// ══════════════════════════════════════════════════════════════════════════════
async function phaseB(snapshotId: string) {
  // ── B1: Snapshot.get() ─────────────────────────────────────────────────────
  section('B1 – Snapshot.get()');
  const snap = await Snapshot.get({ ...CREDS, snapshotId });
  log('snapshotId',      snap.snapshotId);
  log('sourceSandboxId', snap.sourceSandboxId);
  log('status',          snap.status);
  log('sizeBytes',       snap.sizeBytes);
  log('createdAt',       snap.createdAt);
  log('expiresAt',       snap.expiresAt);

  // ── B2: Snapshot.list() ────────────────────────────────────────────────────
  section('B2 – Snapshot.list()');
  const snapList = await Snapshot.list({ ...CREDS, limit: 5 });
  logRaw('snapshots (first 5)', snapList.json.snapshots.map((s: any) => ({
    snapshotId:      s.snapshotId,
    sourceSandboxId: s.sourceSandboxId,
    status:          s.status,
    createdAt:       s.createdAt,
  })));

  // ── B3: Create sandbox FROM snapshot ───────────────────────────────────────
  section('B3 – Sandbox.create() from snapshot');
  const t3 = timer();
  const restored = await Sandbox.create({
    ...CREDS,
    source:  { type: 'snapshot', snapshotId },
    runtime: 'node22',
    timeout: 3 * 60 * 1000,
  });
  log('elapsed',   t3.elapsed());
  log('sandboxId', restored.sandboxId);
  log('status',    restored.status);
  log('timeout',   restored.timeout);

  // ── B4: Verify files from Phase A survived the snapshot ────────────────────
  section('B4 – Verify files survived snapshot');
  const hello = await restored.readFileToBuffer({ path: 'hello.txt' });
  log('hello.txt',  hello ? hello.toString('utf-8') : null);

  const data = await restored.readFileToBuffer({ path: 'data.json' });
  log('data.json',  data ? data.toString('utf-8') : null);

  const nested = await restored.readFileToBuffer({ path: 'subdir/nested.txt' });
  log('subdir/nested.txt', nested ? nested.toString('utf-8') : null);

  const created = await restored.readFileToBuffer({ path: 'created-dir/sub' });
  log('created-dir/sub (dir, expect null or error)', created);

  // ── B5: Write NEW file after restore, then read back ──────────────────────
  section('B5 – Write + read after restore');
  await restored.writeFiles([
    { path: 'post-restore.txt', content: Buffer.from('written after restore') },
  ]);
  const postRestore = await restored.readFileToBuffer({ path: 'post-restore.txt' });
  log('post-restore.txt', postRestore?.toString('utf-8'));

  // ── B6: Run command on restored sandbox ────────────────────────────────────
  section('B6 – runCommand on restored sandbox');
  const whoami = await restored.runCommand({ cmd: 'whoami' });
  log('whoami exitCode', whoami.exitCode);
  log('whoami stdout',   await whoami.stdout());

  const uname = await restored.runCommand({ cmd: 'uname', args: ['-a'] });
  log('uname -a',        await uname.stdout());

  // ── B7: Detached command + kill ────────────────────────────────────────────
  section('B7 – Detached long-running command + kill()');
  const longCmd = await restored.runCommand({
    cmd:      'node',
    args:     ['-e', `
      (async () => {
        let i = 0;
        while (true) {
          console.log('tick ' + (i++));
          await new Promise(r => setTimeout(r, 300));
        }
      })();
    `],
    detached: true,
  });
  log('cmdId', longCmd.cmdId);
  log('exitCode (before kill)', longCmd.exitCode);

  // Collect a few log lines
  const killLogs: string[] = [];
  const logIter = longCmd.logs();
  for (let i = 0; i < 4; i++) {
    const { value, done } = await logIter.next();
    if (done) break;
    killLogs.push(`[${value.stream}] ${value.data.trimEnd()}`);
  }
  logRaw('logs before kill (first 4)', killLogs);

  // Kill the command
  await longCmd.kill('SIGTERM');
  log('kill(SIGTERM) sent');

  // Wait for exit
  try {
    const killResult = await longCmd.wait();
    log('exitCode after kill', killResult.exitCode);
  } catch (err: unknown) {
    log('wait() after kill threw', (err as Error).message);
  }

  // ── B8: getCommand() – retrieve command by ID ─────────────────────────────
  section('B8 – sandbox.getCommand() by cmdId');
  try {
    const retrieved = await restored.getCommand(longCmd.cmdId);
    log('retrieved cmdId', retrieved.cmdId);
    log('retrieved exitCode', retrieved.exitCode);
  } catch (err: unknown) {
    log('getCommand() threw', (err as Error).message);
  }

  // ── B9: sudo command ───────────────────────────────────────────────────────
  section('B9 – runCommand() with sudo');
  const sudoCmd = await restored.runCommand({
    cmd:  'id',
    sudo: true,
  });
  log('exitCode', sudoCmd.exitCode);
  log('stdout',   await sudoCmd.stdout());

  // ── B10: output() helper ──────────────────────────────────────────────────
  section('B10 – command.output("both")');
  const bothCmd = await restored.runCommand({
    cmd:  'node',
    args: ['-e', `console.log('OUT'); console.error('ERR');`],
  });
  log('output("both")', await bothCmd.output('both'));
  log('output("stdout")', await bothCmd.output('stdout'));
  log('output("stderr")', await bothCmd.output('stderr'));

  // ── B11: Stop the sandbox ──────────────────────────────────────────────────
  section('B11 – sandbox.stop()');
  const t11 = timer();
  await restored.stop();
  log('elapsed', t11.elapsed());

  // Verify it's gone
  try {
    await Sandbox.get({ ...CREDS, sandboxId: restored.sandboxId });
    log('Sandbox.get() after stop – still reachable (unexpected)');
  } catch (err: unknown) {
    log('Sandbox.get() after stop threw (expected)', (err as Error).message);
  }

  // ── B12: Delete the snapshot (cleanup) ─────────────────────────────────────
  section('B12 – snapshot.delete() cleanup');
  await snap.delete();
  log('snapshot deleted');

  // Verify deletion
  try {
    const gone = await Snapshot.get({ ...CREDS, snapshotId });
    log('Snapshot.get() after delete – status', gone.status);
  } catch (err: unknown) {
    log('Snapshot.get() after delete threw', (err as Error).message);
  }

  // ── Cleanup state files ────────────────────────────────────────────────────
  writeFileSync(stateFile('snapshotId'), '');  // clear so next run is fresh Phase A
  console.log('\n  ✅ Phase B complete. All scenarios exercised. Delete /tmp/sandbox-exploration to re-run from scratch.');
}

// ─── Entry ───────────────────────────────────────────────────────────────────
main().catch((err: unknown) => {
  console.error('\n  ❌ FATAL:', err);
  process.exit(1);
});
