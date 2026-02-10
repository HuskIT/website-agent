/**
 * sandbox-debug.ts
 *
 * Diagnostic script to download project data from Supabase, analyze snapshots,
 * and reproduce the Vercel SDK `writeFiles` 400 error.
 *
 * Usage:
 *   # Download & analyze failing project
 *   npx tsx scripts/sandbox-debug.ts download aa9229ff-797f-4d32-9e80-166a2f4c6a96
 *
 *   # Download & analyze ANY project (for comparison)
 *   npx tsx scripts/sandbox-debug.ts download <project-id>
 *
 *   # List recent projects (pick a working one to compare)
 *   npx tsx scripts/sandbox-debug.ts list
 *
 *   # Compare two downloaded projects
 *   npx tsx scripts/sandbox-debug.ts compare <project-id-1> <project-id-2>
 *
 *   # Reproduce writeFiles error against a live sandbox
 *   npx tsx scripts/sandbox-debug.ts reproduce <project-id>
 *
 *   # Test writeFiles with path normalization (strip leading /)
 *   npx tsx scripts/sandbox-debug.ts reproduce <project-id> --fix-paths
 *
 * State files: /tmp/sandbox-debug/<project-id>/
 * Requires: DATABASE_URL in .env.local, VERCEL_TOKEN/TEAM_ID/PROJECT_ID for reproduce
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { createRequire } from 'node:module';

// Load env
config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

// Postgres (same pattern as migrate-auth.ts)
const require2 = createRequire(import.meta.url);
const postgresModule = require2('postgres');
const postgres = (postgresModule.default ?? postgresModule) as typeof import('postgres');

// ─── Config ──────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const STATE_DIR = '/tmp/sandbox-debug';
const VERCEL_CREDS = {
  token: process.env.VERCEL_TOKEN!,
  teamId: process.env.VERCEL_TEAM_ID!,
  projectId: process.env.VERCEL_PROJECT_ID!,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function projectDir(projectId: string) {
  const dir = `${STATE_DIR}/${projectId}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function saveJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function loadJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function section(title: string) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(72)}`);
}

function log(label: string, value: unknown) {
  console.log(`  ${label}:`, value);
}

// ─── Database Connection ─────────────────────────────────────────────────────
function createDb() {
  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL not set. Check .env.local');
    process.exit(1);
  }
  return postgres(DATABASE_URL, { max: 1, idle_timeout: 20, connect_timeout: 10 });
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * LIST: Show recent projects with sandbox info
 */
async function cmdList() {
  section('Recent Projects');
  const sql = createDb();

  try {
    const projects = await sql`
      SELECT
        p.id,
        p.name,
        p.status,
        p.sandbox_id,
        p.sandbox_provider,
        p.sandbox_expires_at,
        p.created_at,
        p.updated_at,
        (SELECT COUNT(*) FROM project_snapshots ps WHERE ps.project_id = p.id) as has_snapshot,
        (SELECT COUNT(*) FROM project_messages pm WHERE pm.project_id = p.id) as message_count
      FROM projects p
      ORDER BY p.updated_at DESC
      LIMIT 20
    `;

    console.log(`\n  Found ${projects.length} projects:\n`);
    console.log(
      '  ' +
        ['ID', 'Name', 'Status', 'Sandbox', 'Provider', 'Snap', 'Msgs', 'Updated'].join(' | '),
    );
    console.log('  ' + '-'.repeat(120));

    for (const p of projects) {
      console.log(
        `  ${p.id} | ${(p.name || '').slice(0, 20).padEnd(20)} | ${(p.status || '').padEnd(10)} | ${(p.sandbox_id || 'none').slice(0, 12).padEnd(12)} | ${(p.sandbox_provider || 'none').padEnd(12)} | ${p.has_snapshot ? 'YES' : 'no '.padEnd(3)} | ${String(p.message_count).padStart(4)} | ${p.updated_at ? new Date(p.updated_at).toISOString().slice(0, 19) : 'never'}`,
      );
    }
  } finally {
    await sql.end();
  }
}

/**
 * DOWNLOAD: Fetch a project + snapshot + messages from Supabase
 */
async function cmdDownload(projectId: string) {
  section(`Downloading Project: ${projectId}`);
  const sql = createDb();
  const dir = projectDir(projectId);

  try {
    // 1. Project record
    const [project] = await sql`
      SELECT * FROM projects WHERE id = ${projectId}
    `;

    if (!project) {
      console.error(`❌ Project ${projectId} not found`);
      return;
    }

    saveJson(`${dir}/project.json`, project);
    log('Project name', project.name);
    log('Status', project.status);
    log('Sandbox ID', project.sandbox_id);
    log('Sandbox provider', project.sandbox_provider);
    log('Sandbox expires', project.sandbox_expires_at);
    log('Created', project.created_at);
    log('Updated', project.updated_at);
    log('Saved to', `${dir}/project.json`);

    // 2. Snapshot
    section('Snapshot');
    const [snapshot] = await sql`
      SELECT * FROM project_snapshots WHERE project_id = ${projectId}
    `;

    if (!snapshot) {
      console.log('  No snapshot found for this project');
    } else {
      // Save full snapshot
      saveJson(`${dir}/snapshot-full.json`, snapshot);

      // Analyze files
      const files = snapshot.files as Record<string, { type?: string; content?: string; isBinary?: boolean }>;
      const fileEntries = Object.entries(files);
      const fileCount = fileEntries.filter(([, v]) => v?.type === 'file' || (v && 'content' in v)).length;
      const folderCount = fileEntries.filter(([, v]) => v?.type === 'folder').length;
      const unknownCount = fileEntries.length - fileCount - folderCount;

      log('Total entries', fileEntries.length);
      log('Files', fileCount);
      log('Folders', folderCount);
      log('Unknown type', unknownCount);
      log('Vercel snapshot ID', snapshot.vercel_snapshot_id);
      log('Saved to', `${dir}/snapshot-full.json`);

      // Save path analysis
      const pathAnalysis = analyzeSnapshotPaths(files);
      saveJson(`${dir}/path-analysis.json`, pathAnalysis);
      log('Path analysis saved to', `${dir}/path-analysis.json`);

      // Print path analysis summary
      section('Path Analysis');
      log('Paths with leading /', pathAnalysis.leadingSlashCount);
      log('Paths without leading /', pathAnalysis.noLeadingSlashCount);
      log('Max depth', pathAnalysis.maxDepth);
      log('Contains node_modules', pathAnalysis.hasNodeModules);
      log('Contains .git', pathAnalysis.hasDotGit);
      log('Total content size (bytes)', pathAnalysis.totalContentSize);
      log('Largest file', `${pathAnalysis.largestFile.path} (${pathAnalysis.largestFile.size} bytes)`);
      log('Binary files', pathAnalysis.binaryFileCount);
      log('Empty content files', pathAnalysis.emptyContentCount);
      log('Null/undefined content', pathAnalysis.nullContentCount);

      if (pathAnalysis.suspiciousPaths.length > 0) {
        section('Suspicious Paths (potential SDK issues)');
        for (const p of pathAnalysis.suspiciousPaths) {
          console.log(`  - ${p.reason}: ${p.path}`);
        }
      }

      // Save just file paths for easy viewing
      const pathsOnly = fileEntries
        .filter(([, v]) => v?.type !== 'folder')
        .map(([path, v]) => ({
          path,
          isBinary: (v as any)?.isBinary || false,
          contentLength: (v as any)?.content?.length || 0,
          hasContent: !!(v as any)?.content,
        }));
      saveJson(`${dir}/file-paths.json`, pathsOnly);
      log('File paths saved to', `${dir}/file-paths.json`);
    }

    // 3. Messages (save count + first/last for context)
    section('Messages');
    const messages = await sql`
      SELECT id, message_id, sequence_num, role, created_at,
             length(content::text) as content_size
      FROM project_messages
      WHERE project_id = ${projectId}
      ORDER BY sequence_num ASC
    `;

    log('Total messages', messages.length);

    if (messages.length > 0) {
      log('First message', `seq=${messages[0].sequence_num} role=${messages[0].role} at=${messages[0].created_at}`);
      log(
        'Last message',
        `seq=${messages[messages.length - 1].sequence_num} role=${messages[messages.length - 1].role} at=${messages[messages.length - 1].created_at}`,
      );

      // Save message summary (not full content - could be huge)
      saveJson(
        `${dir}/messages-summary.json`,
        messages.map((m) => ({
          id: m.id,
          message_id: m.message_id,
          sequence_num: m.sequence_num,
          role: m.role,
          content_size: m.content_size,
          created_at: m.created_at,
        })),
      );
      log('Messages summary saved to', `${dir}/messages-summary.json`);
    }

    console.log(`\n  ✅ Project data saved to: ${dir}/`);
  } finally {
    await sql.end();
  }
}

/**
 * Analyze snapshot file paths for SDK compatibility issues
 */
function analyzeSnapshotPaths(files: Record<string, any>) {
  const entries = Object.entries(files);
  let leadingSlashCount = 0;
  let noLeadingSlashCount = 0;
  let maxDepth = 0;
  let hasNodeModules = false;
  let hasDotGit = false;
  let totalContentSize = 0;
  let largestFile = { path: '', size: 0 };
  let binaryFileCount = 0;
  let emptyContentCount = 0;
  let nullContentCount = 0;
  const suspiciousPaths: Array<{ path: string; reason: string }> = [];

  for (const [path, value] of entries) {
    // Skip folders
    if (value?.type === 'folder') continue;

    // Leading slash check
    if (path.startsWith('/')) {
      leadingSlashCount++;
    } else {
      noLeadingSlashCount++;
    }

    // Depth
    const depth = path.split('/').filter(Boolean).length;
    if (depth > maxDepth) maxDepth = depth;

    // node_modules / .git
    if (path.includes('node_modules')) hasNodeModules = true;
    if (path.includes('.git/') || path === '.git') hasDotGit = true;

    // Content analysis
    const content = value?.content;
    if (content === null || content === undefined) {
      nullContentCount++;
      suspiciousPaths.push({ path, reason: 'null/undefined content' });
    } else if (typeof content === 'string') {
      if (content.length === 0) {
        emptyContentCount++;
      }
      totalContentSize += content.length;
      if (content.length > largestFile.size) {
        largestFile = { path, size: content.length };
      }
    } else {
      suspiciousPaths.push({ path, reason: `unexpected content type: ${typeof content}` });
    }

    // Binary
    if (value?.isBinary) binaryFileCount++;

    // Suspicious path patterns
    if (path.includes('\\')) {
      suspiciousPaths.push({ path, reason: 'contains backslash' });
    }
    if (path.includes('//')) {
      suspiciousPaths.push({ path, reason: 'contains double slash' });
    }
    if (path.includes(' ')) {
      suspiciousPaths.push({ path, reason: 'contains space' });
    }
    if (/[^\x20-\x7E/.]/.test(path.replace(/\//g, ''))) {
      suspiciousPaths.push({ path, reason: 'contains non-ASCII or control characters' });
    }
    if (path.length > 255) {
      suspiciousPaths.push({ path: path.slice(0, 100) + '...', reason: 'path too long (>255 chars)' });
    }
  }

  return {
    leadingSlashCount,
    noLeadingSlashCount,
    maxDepth,
    hasNodeModules,
    hasDotGit,
    totalContentSize,
    largestFile,
    binaryFileCount,
    emptyContentCount,
    nullContentCount,
    suspiciousPaths,
  };
}

/**
 * COMPARE: Side-by-side comparison of two downloaded projects
 */
async function cmdCompare(projectId1: string, projectId2: string) {
  section(`Comparing Projects`);
  log('Project A', projectId1);
  log('Project B', projectId2);

  const dir1 = projectDir(projectId1);
  const dir2 = projectDir(projectId2);

  const analysis1 = loadJson<ReturnType<typeof analyzeSnapshotPaths>>(`${dir1}/path-analysis.json`);
  const analysis2 = loadJson<ReturnType<typeof analyzeSnapshotPaths>>(`${dir2}/path-analysis.json`);

  if (!analysis1) {
    console.error(`❌ No path analysis for ${projectId1}. Run 'download' first.`);
    return;
  }
  if (!analysis2) {
    console.error(`❌ No path analysis for ${projectId2}. Run 'download' first.`);
    return;
  }

  section('Path Format');
  console.log(`  ${'Metric'.padEnd(30)} | ${'Project A'.padEnd(15)} | ${'Project B'.padEnd(15)}`);
  console.log('  ' + '-'.repeat(65));

  const metrics: [string, keyof typeof analysis1][] = [
    ['Leading / paths', 'leadingSlashCount'],
    ['No leading / paths', 'noLeadingSlashCount'],
    ['Max depth', 'maxDepth'],
    ['Has node_modules', 'hasNodeModules'],
    ['Has .git', 'hasDotGit'],
    ['Total content size', 'totalContentSize'],
    ['Binary files', 'binaryFileCount'],
    ['Empty content files', 'emptyContentCount'],
    ['Null content files', 'nullContentCount'],
    ['Suspicious paths', 'suspiciousPaths'],
  ];

  for (const [label, key] of metrics) {
    const v1 = key === 'suspiciousPaths' ? (analysis1[key] as any[]).length : analysis1[key];
    const v2 = key === 'suspiciousPaths' ? (analysis2[key] as any[]).length : analysis2[key];
    const marker = String(v1) !== String(v2) ? ' ← DIFF' : '';
    console.log(
      `  ${label.padEnd(30)} | ${String(v1).padEnd(15)} | ${String(v2).padEnd(15)}${marker}`,
    );
  }

  // Show suspicious paths from both
  if ((analysis1.suspiciousPaths as any[]).length > 0) {
    section('Suspicious Paths — Project A');
    for (const p of analysis1.suspiciousPaths) {
      console.log(`  - ${p.reason}: ${p.path}`);
    }
  }
  if ((analysis2.suspiciousPaths as any[]).length > 0) {
    section('Suspicious Paths — Project B');
    for (const p of analysis2.suspiciousPaths) {
      console.log(`  - ${p.reason}: ${p.path}`);
    }
  }

  // Compare file paths
  section('File Path Differences');
  const paths1 = loadJson<Array<{ path: string }>>(`${dir1}/file-paths.json`);
  const paths2 = loadJson<Array<{ path: string }>>(`${dir2}/file-paths.json`);

  if (paths1 && paths2) {
    const set1 = new Set(paths1.map((p) => p.path));
    const set2 = new Set(paths2.map((p) => p.path));

    // Normalize and compare
    const norm1 = new Set(paths1.map((p) => p.path.replace(/^\//, '')));
    const norm2 = new Set(paths2.map((p) => p.path.replace(/^\//, '')));

    const onlyInA = [...norm1].filter((p) => !norm2.has(p));
    const onlyInB = [...norm2].filter((p) => !norm1.has(p));
    const common = [...norm1].filter((p) => norm2.has(p));

    log('Files only in A', onlyInA.length);
    log('Files only in B', onlyInB.length);
    log('Common files', common.length);

    if (onlyInA.length > 0 && onlyInA.length <= 20) {
      console.log('\n  Only in A:');
      for (const p of onlyInA) console.log(`    ${p}`);
    }
    if (onlyInB.length > 0 && onlyInB.length <= 20) {
      console.log('\n  Only in B:');
      for (const p of onlyInB) console.log(`    ${p}`);
    }
  }
}

/**
 * REPRODUCE: Try to write snapshot files to a live Vercel sandbox
 */
async function cmdReproduce(projectId: string, fixPaths: boolean) {
  section(`Reproducing writeFiles for Project: ${projectId}`);

  if (!VERCEL_CREDS.token || !VERCEL_CREDS.teamId || !VERCEL_CREDS.projectId) {
    console.error('❌ Missing VERCEL_TOKEN, VERCEL_TEAM_ID, or VERCEL_PROJECT_ID in .env.local');
    process.exit(1);
  }

  const dir = projectDir(projectId);
  const snapshotPath = `${dir}/snapshot-full.json`;

  if (!existsSync(snapshotPath)) {
    console.error(`❌ No snapshot at ${snapshotPath}. Run 'download ${projectId}' first.`);
    return;
  }

  const snapshot = loadJson<{ files: Record<string, any> }>(snapshotPath);
  if (!snapshot?.files) {
    console.error('❌ Snapshot has no files');
    return;
  }

  // Dynamically import Vercel Sandbox SDK
  const { Sandbox } = await import('@vercel/sandbox');

  // Create a fresh sandbox
  section('Creating fresh sandbox');
  const sandbox = await Sandbox.create({
    ...VERCEL_CREDS,
    runtime: 'node22',
    timeout: 3 * 60 * 1000,
    ports: [3000, 5173],
  });
  log('Sandbox ID', sandbox.sandboxId);
  log('Status', sandbox.status);

  try {
    // Prepare files from snapshot
    const filesToWrite: Array<{ path: string; content: Buffer }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    for (const [filePath, fileData] of Object.entries(snapshot.files)) {
      // Skip folders
      if (fileData?.type === 'folder') {
        skipped.push({ path: filePath, reason: 'folder' });
        continue;
      }

      // Skip null content
      if (!fileData?.content && fileData?.content !== '') {
        skipped.push({ path: filePath, reason: 'null/missing content' });
        continue;
      }

      // Path normalization
      let normalizedPath = filePath;
      if (fixPaths) {
        // Strip leading / (Vercel SDK expects relative paths)
        normalizedPath = filePath.replace(/^\/+/, '');
        if (!normalizedPath) {
          skipped.push({ path: filePath, reason: 'empty after normalization' });
          continue;
        }
      }

      const content = fileData.isBinary
        ? Buffer.from(fileData.content, 'base64')
        : Buffer.from(fileData.content, 'utf-8');

      filesToWrite.push({ path: normalizedPath, content });
    }

    log('Files to write', filesToWrite.length);
    log('Skipped', skipped.length);
    log('Fix paths mode', fixPaths);

    if (skipped.length > 0) {
      const reasons = skipped.reduce(
        (acc, s) => {
          acc[s.reason] = (acc[s.reason] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      log('Skip reasons', reasons);
    }

    // Show sample paths
    section('Sample File Paths (first 10)');
    for (const f of filesToWrite.slice(0, 10)) {
      console.log(`  ${f.path} (${f.content.length} bytes)`);
    }

    // Try writing in chunks (same logic as api.sandbox.files.ts)
    const CHUNK_SIZE = 20; // Files per chunk
    const totalChunks = Math.ceil(filesToWrite.length / CHUNK_SIZE);

    section(`Writing Files (${totalChunks} chunks of ${CHUNK_SIZE})`);

    let successCount = 0;
    let failedChunk = -1;

    for (let i = 0; i < totalChunks; i++) {
      const chunk = filesToWrite.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const chunkPaths = chunk.map((f) => f.path);

      try {
        console.log(`  Chunk ${i + 1}/${totalChunks} (${chunk.length} files)...`);
        await sandbox.writeFiles(chunk);
        console.log(`  ✅ Chunk ${i + 1} OK`);
        successCount += chunk.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ Chunk ${i + 1} FAILED: ${msg}`);
        failedChunk = i;

        // Save failed chunk details
        saveJson(`${dir}/failed-chunk-${i}.json`, {
          chunkIndex: i,
          error: msg,
          paths: chunkPaths,
          fixPaths,
        });
        log('Failed chunk saved to', `${dir}/failed-chunk-${i}.json`);

        // Try individual files in the failed chunk to find the culprit
        section(`Isolating failure in chunk ${i + 1}`);
        for (const file of chunk) {
          try {
            await sandbox.writeFiles([file]);
            console.log(`  ✅ ${file.path} (${file.content.length} bytes)`);
          } catch (fileErr) {
            const fileMsg = fileErr instanceof Error ? fileErr.message : String(fileErr);
            console.error(`  ❌ ${file.path} (${file.content.length} bytes): ${fileMsg}`);

            // Save the problematic file details
            saveJson(`${dir}/problem-file.json`, {
              path: file.path,
              originalPath: Object.keys(snapshot.files).find(
                (k) => k === file.path || k.replace(/^\/+/, '') === file.path,
              ),
              contentLength: file.content.length,
              contentPreview: file.content.toString('utf-8').slice(0, 500),
              isBinary: snapshot.files[file.path]?.isBinary || false,
              error: fileMsg,
            });
            log('Problem file saved to', `${dir}/problem-file.json`);
          }
        }

        break; // Stop after first failed chunk
      }

      // Delay between chunks
      if (i < totalChunks - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    section('Results');
    log('Files written successfully', successCount);
    log('Total files attempted', filesToWrite.length);
    log('Failed at chunk', failedChunk >= 0 ? failedChunk + 1 : 'none');
    log('Fix paths mode', fixPaths);

    if (failedChunk < 0) {
      console.log('\n  ✅ All files written successfully!');
      if (!fixPaths) {
        console.log('  → Files work WITH leading slashes (issue is elsewhere)');
      } else {
        console.log('  → Files work WITHOUT leading slashes (path normalization needed)');
      }
    } else {
      console.log('\n  ❌ Write failed. Check the problem-file.json for details.');
      if (!fixPaths) {
        console.log('  → Try again with --fix-paths to test path normalization');
      }
    }

    // Verify with find
    section('Verification (find -type f | wc -l)');
    const findResult = await sandbox.runCommand({ cmd: 'sh', args: ['-c', 'find . -type f | wc -l'] });
    log('Files in sandbox', (await findResult.stdout()).trim());
    log('Expected', filesToWrite.length);
  } finally {
    // Cleanup
    section('Cleanup');
    try {
      await sandbox.stop();
      log('Sandbox stopped', sandbox.sandboxId);
    } catch {
      log('Sandbox may already be stopped', sandbox.sandboxId);
    }
  }
}

// ─── CLI Entry ───────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  sandbox-debug — Vercel Sandbox writeFiles diagnostic tool          ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  switch (command) {
    case 'list':
      await cmdList();
      break;

    case 'download':
      if (!args[1]) {
        console.error('Usage: npx tsx scripts/sandbox-debug.ts download <project-id>');
        process.exit(1);
      }
      await cmdDownload(args[1]);
      break;

    case 'compare':
      if (!args[1] || !args[2]) {
        console.error('Usage: npx tsx scripts/sandbox-debug.ts compare <project-id-1> <project-id-2>');
        process.exit(1);
      }
      await cmdCompare(args[1], args[2]);
      break;

    case 'reproduce':
      if (!args[1]) {
        console.error('Usage: npx tsx scripts/sandbox-debug.ts reproduce <project-id> [--fix-paths]');
        process.exit(1);
      }
      await cmdReproduce(args[1], args.includes('--fix-paths'));
      break;

    default:
      console.log(`
  Commands:
    list                                    List recent projects
    download <project-id>                   Download project + snapshot from Supabase
    compare <project-id-1> <project-id-2>   Compare two downloaded projects
    reproduce <project-id>                  Reproduce writeFiles error with Vercel SDK
    reproduce <project-id> --fix-paths      Test with leading / stripped from paths

  Examples:
    npx tsx scripts/sandbox-debug.ts list
    npx tsx scripts/sandbox-debug.ts download aa9229ff-797f-4d32-9e80-166a2f4c6a96
    npx tsx scripts/sandbox-debug.ts reproduce aa9229ff-797f-4d32-9e80-166a2f4c6a96
    npx tsx scripts/sandbox-debug.ts reproduce aa9229ff-797f-4d32-9e80-166a2f4c6a96 --fix-paths
`);
      break;
  }
}

main().catch((err) => {
  console.error('\n  ❌ FATAL:', err);
  process.exit(1);
});
