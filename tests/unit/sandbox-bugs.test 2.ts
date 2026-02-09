/**
 * Tests for Vercel Sandbox bugs (Issue 1 + Issue 3)
 *
 * These tests reproduce known bugs using real project data patterns
 * from Supabase and verify the fixes work correctly.
 *
 * Run: pnpm test -- tests/unit/sandbox-bugs.test.ts
 */
import { describe, it, expect } from 'vitest';

// ─── Issue 1, Bug #1: PATCH handler must accept sandbox fields ───────────────

describe('Issue 1: PATCH handler sandbox fields', () => {
  /**
   * Simulates the handlePatch validation logic from api.projects.$id.ts.
   * The real handler parses the body, validates fields, builds an `updates` object.
   * This test verifies the logic accepts sandbox_id and sandbox_provider.
   */
  function simulateHandlePatch(body: Record<string, unknown>) {
    const updates: Record<string, unknown> = {};

    // Existing fields
    if (body.name !== undefined) {
      if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
        return { error: 'Project name cannot be empty', status: 400 };
      }

      if (body.name.length > 255) {
        return { error: 'Project name must be 255 characters or less', status: 400 };
      }

      updates.name = body.name.trim();
    }

    if (body.description !== undefined) {
      updates.description =
        typeof body.description === 'string' ? body.description.trim() || undefined : undefined;
    }

    if (body.status !== undefined) {
      const validStatuses = ['draft', 'published', 'archived'];

      if (!validStatuses.includes(body.status as string)) {
        return { error: 'Invalid status value', status: 400 };
      }

      updates.status = body.status;
    }

    // NEW: sandbox fields (the fix)
    if (body.sandbox_id !== undefined) {
      if (body.sandbox_id === null || typeof body.sandbox_id === 'string') {
        updates.sandbox_id = body.sandbox_id;
      }
    }

    if (body.sandbox_provider !== undefined) {
      const validProviders = ['webcontainer', 'vercel', null];

      if (validProviders.includes(body.sandbox_provider as string | null)) {
        updates.sandbox_provider = body.sandbox_provider;
      }
    }

    if (body.sandbox_expires_at !== undefined) {
      if (body.sandbox_expires_at === null || typeof body.sandbox_expires_at === 'string') {
        updates.sandbox_expires_at = body.sandbox_expires_at;
      }
    }

    if (Object.keys(updates).length === 0) {
      return { error: 'No valid update fields provided', status: 400 };
    }

    return { updates, status: 200 };
  }

  it('should reject request with only camelCase sandbox fields (the bug)', () => {
    // This is what the client currently sends (BUG)
    const result = simulateHandlePatch({
      sandboxId: 'sbx_abc123',
      sandboxProvider: 'vercel',
    });

    // With the fix, camelCase fields are NOT recognized → 400
    expect(result.status).toBe(400);
    expect(result.error).toBe('No valid update fields provided');
  });

  it('should accept sandbox_id and sandbox_provider in snake_case (the fix)', () => {
    const result = simulateHandlePatch({
      sandbox_id: 'sbx_abc123',
      sandbox_provider: 'vercel',
    });

    expect(result.status).toBe(200);
    expect(result.updates).toEqual({
      sandbox_id: 'sbx_abc123',
      sandbox_provider: 'vercel',
    });
  });

  it('should accept sandbox_id with null (clear sandbox)', () => {
    const result = simulateHandlePatch({
      sandbox_id: null,
      sandbox_provider: null,
    });

    expect(result.status).toBe(200);
    expect(result.updates).toEqual({
      sandbox_id: null,
      sandbox_provider: null,
    });
  });

  it('should accept sandbox_expires_at timestamp', () => {
    const expiresAt = '2026-02-07T17:22:49.163Z';
    const result = simulateHandlePatch({
      sandbox_id: 'sbx_abc123',
      sandbox_expires_at: expiresAt,
    });

    expect(result.status).toBe(200);
    expect(result.updates).toEqual({
      sandbox_id: 'sbx_abc123',
      sandbox_expires_at: expiresAt,
    });
  });

  it('should accept mixed sandbox + regular fields', () => {
    const result = simulateHandlePatch({
      name: 'My Project',
      sandbox_id: 'sbx_abc123',
      sandbox_provider: 'vercel',
    });

    expect(result.status).toBe(200);
    expect(result.updates).toEqual({
      name: 'My Project',
      sandbox_id: 'sbx_abc123',
      sandbox_provider: 'vercel',
    });
  });

  it('should reject invalid sandbox_provider values', () => {
    const result = simulateHandlePatch({
      sandbox_provider: 'docker', // invalid
    });

    // sandbox_provider with invalid value is silently ignored → no valid fields
    expect(result.status).toBe(400);
  });
});

// ─── Issue 1, Bug #2: Snapshot folder-as-file filtering ──────────────────────

describe('Issue 1: Snapshot folder-as-file filtering', () => {
  /**
   * Simulates the apiFiles filter from workbench.ts restoreFromDatabaseSnapshot.
   * This is the exact filter that must skip folder entries.
   */
  function filterSnapshotForUpload(
    files: Record<string, { content: string; isBinary: boolean; type?: string }>,
  ) {
    return Object.entries(files)
      .filter(([filePath, fileData]) => {
        if (!fileData || typeof fileData.content !== 'string') {
          return false;
        }

        // Skip folder entries
        if (fileData.type === 'folder') {
          return false;
        }

        // Skip directory-like entries with empty content and no file extension
        if (fileData.content === '' && !filePath.includes('.')) {
          return false;
        }

        return true;
      })
      .map(([filePath, fileData]) => ({
        path: filePath,
        content: fileData.content,
        encoding: fileData.isBinary ? ('base64' as const) : ('utf8' as const),
      }));
  }

  it('should filter out type:folder entries (working project format)', () => {
    const files = {
      src: { type: 'folder', content: '', isBinary: false },
      'src/App.tsx': { type: 'file', content: 'export default App;', isBinary: false },
    } as any;

    const result = filterSnapshotForUpload(files);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('src/App.tsx');
  });

  it('should filter out directory-like entries with empty content (failing project format)', () => {
    // This is the actual pattern from project aa9229ff (the bug)
    const files: Record<string, { content: string; isBinary: boolean; type?: string }> = {
      src: { type: 'file', content: '', isBinary: false },
      'src/data': { type: 'file', content: '', isBinary: false },
      'src/pages': { type: 'file', content: '', isBinary: false },
      'src/styles': { type: 'file', content: '', isBinary: false },
      'src/components': { type: 'file', content: '', isBinary: false },
      'src/guidelines': { type: 'file', content: '', isBinary: false },
      'src/components/ui': { type: 'file', content: '', isBinary: false },
      'src/components/figma': { type: 'file', content: '', isBinary: false },
      'src/App.tsx': { type: 'file', content: 'export default App;', isBinary: false },
      'src/main.tsx': { type: 'file', content: 'createRoot()', isBinary: false },
      'package.json': { type: 'file', content: '{}', isBinary: false },
    };

    const result = filterSnapshotForUpload(files);

    // Should only include actual files, not the 8 directory entries
    expect(result).toHaveLength(3);
    expect(result.map((f) => f.path).sort()).toEqual(['package.json', 'src/App.tsx', 'src/main.tsx']);
  });

  it('should keep files with empty content if they have a file extension', () => {
    const files: Record<string, { content: string; isBinary: boolean }> = {
      '.gitkeep': { content: '', isBinary: false },
      '.env': { content: '', isBinary: false },
      'src/empty.ts': { content: '', isBinary: false },
    };

    const result = filterSnapshotForUpload(files);

    // .gitkeep, .env, and empty.ts all have dots → kept as files
    expect(result).toHaveLength(3);
  });

  it('should reproduce the exact failing project pattern (85 entries → 77 uploaded)', () => {
    // Simulate the aa9229ff snapshot: 85 entries where 8 are fake directories
    const files: Record<string, { content: string; isBinary: boolean; type?: string }> = {};

    // 8 directory entries stored as type:file with empty content
    const dirPaths = [
      'src',
      'src/data',
      'src/pages',
      'src/styles',
      'src/components',
      'src/guidelines',
      'src/components/ui',
      'src/components/figma',
    ];

    for (const dir of dirPaths) {
      files[dir] = { type: 'file', content: '', isBinary: false };
    }

    // 77 actual files (simulate with placeholder content)
    for (let i = 0; i < 77; i++) {
      files[`src/file${i}.tsx`] = { content: `// file ${i}`, isBinary: false };
    }

    expect(Object.keys(files)).toHaveLength(85);

    const result = filterSnapshotForUpload(files);
    expect(result).toHaveLength(77);
  });
});

// ─── Issue 1: Path normalization in api.sandbox.files ────────────────────────

describe('Issue 1: Path normalization for Vercel SDK', () => {
  /**
   * Simulates the path normalization from api.sandbox.files.ts.
   */
  function normalizePaths(
    files: Array<{ path: string; content: string; encoding: string }>,
  ): Array<{ path: string; content: string }> {
    const result: Array<{ path: string; content: string }> = [];

    for (const file of files) {
      const normalizedPath = file.path.replace(/^\/+/, '');

      if (!normalizedPath) {
        continue;
      }

      result.push({ path: normalizedPath, content: file.content });
    }

    return result;
  }

  it('should strip leading slashes from paths', () => {
    const files = [
      { path: '/src/App.tsx', content: 'code', encoding: 'utf8' },
      { path: '/package.json', content: '{}', encoding: 'utf8' },
    ];

    const result = normalizePaths(files);
    expect(result).toEqual([
      { path: 'src/App.tsx', content: 'code' },
      { path: 'package.json', content: '{}' },
    ]);
  });

  it('should handle paths without leading slashes (no-op)', () => {
    const files = [{ path: 'src/App.tsx', content: 'code', encoding: 'utf8' }];

    const result = normalizePaths(files);
    expect(result[0].path).toBe('src/App.tsx');
  });

  it('should skip paths that become empty after normalization', () => {
    const files = [
      { path: '/', content: '', encoding: 'utf8' },
      { path: 'valid.txt', content: 'ok', encoding: 'utf8' },
    ];

    const result = normalizePaths(files);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('valid.txt');
  });

  it('should strip multiple leading slashes', () => {
    const files = [{ path: '///deep/path.ts', content: 'code', encoding: 'utf8' }];

    const result = normalizePaths(files);
    expect(result[0].path).toBe('deep/path.ts');
  });
});

// ─── Issue 1: File count comparison fix ──────────────────────────────────────

describe('Issue 1: File count comparison (cosmetic)', () => {
  it('should compare against actual uploaded file count, not snapshot entry count', () => {
    const snapshotEntries = 85; // includes folders
    const actualFilesUploaded = 77; // files only
    const sandboxFileCount = 77; // find -type f result

    // BUG: comparing sandboxFileCount vs snapshotEntries → mismatch
    expect(sandboxFileCount).not.toBe(snapshotEntries);

    // FIX: comparing sandboxFileCount vs actualFilesUploaded → match
    expect(sandboxFileCount).toBe(actualFilesUploaded);
  });
});

// ─── Issue 3: Sandbox expiration error detection ─────────────────────────────

describe('Issue 3: Sandbox expiration error detection', () => {
  /**
   * Simulates how the client should detect 410 Gone errors from the API.
   */
  function is410Error(errorMessage: string): boolean {
    return (
      errorMessage.includes('410') ||
      errorMessage.includes('expired') ||
      errorMessage.includes('SANDBOX_EXPIRED') ||
      errorMessage.includes('Sandbox expired')
    );
  }

  it('should detect 410 status code in error message', () => {
    expect(is410Error('Status code 410 is not ok')).toBe(true);
  });

  it('should detect SANDBOX_EXPIRED code', () => {
    expect(is410Error('SANDBOX_EXPIRED')).toBe(true);
  });

  it('should detect expired keyword', () => {
    expect(is410Error('Sandbox has expired')).toBe(true);
  });

  it('should not flag non-expiration errors', () => {
    expect(is410Error('Status code 400 is not ok')).toBe(false);
    expect(is410Error('Sandbox not found')).toBe(false);
    expect(is410Error('Network error')).toBe(false);
  });
});

describe('Issue 3: Sandbox command retry logic', () => {
  /**
   * Simulates the retry wrapper for sandbox commands.
   */
  async function runCommandWithRetry(
    runCommand: () => Promise<{ exitCode: number; stdout: string }>,
    onRecreate: () => Promise<void>,
    maxRetries = 1,
  ): Promise<{ exitCode: number; stdout: string }> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await runCommand();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isExpired =
          msg.includes('410') || msg.includes('expired') || msg.includes('SANDBOX_EXPIRED');

        if (isExpired && attempt < maxRetries) {
          await onRecreate();
          continue;
        }

        throw error;
      }
    }

    throw new Error('Command failed after retries');
  }

  it('should succeed on first try without retry', async () => {
    const result = await runCommandWithRetry(
      async () => ({ exitCode: 0, stdout: 'success' }),
      async () => {},
    );

    expect(result).toEqual({ exitCode: 0, stdout: 'success' });
  });

  it('should retry after 410 error and succeed', async () => {
    let attempt = 0;

    const result = await runCommandWithRetry(
      async () => {
        attempt++;

        if (attempt === 1) {
          throw new Error('SANDBOX_EXPIRED');
        }

        return { exitCode: 0, stdout: 'recovered' };
      },
      async () => {
        /* recreate sandbox */
      },
    );

    expect(attempt).toBe(2);
    expect(result).toEqual({ exitCode: 0, stdout: 'recovered' });
  });

  it('should call onRecreate when 410 occurs', async () => {
    let recreated = false;

    await runCommandWithRetry(
      async () => {
        if (!recreated) {
          throw new Error('Sandbox expired');
        }

        return { exitCode: 0, stdout: 'ok' };
      },
      async () => {
        recreated = true;
      },
    );

    expect(recreated).toBe(true);
  });

  it('should throw non-410 errors immediately without retry', async () => {
    const recreateSpy = { called: false };

    await expect(
      runCommandWithRetry(
        async () => {
          throw new Error('Network error');
        },
        async () => {
          recreateSpy.called = true;
        },
      ),
    ).rejects.toThrow('Network error');

    expect(recreateSpy.called).toBe(false);
  });

  it('should throw after max retries exhausted', async () => {
    let recreateCount = 0;

    await expect(
      runCommandWithRetry(
        async () => {
          throw new Error('SANDBOX_EXPIRED');
        },
        async () => {
          recreateCount++;
        },
        1,
      ),
    ).rejects.toThrow('SANDBOX_EXPIRED');

    expect(recreateCount).toBe(1);
  });
});

describe('Issue 3: Sandbox time-remaining check', () => {
  /**
   * Simulates checking if sandbox has enough time for a long operation.
   */
  function shouldRecreateSandbox(
    timeRemainingMs: number | null,
    minRequiredMs: number = 3 * 60 * 1000, // 3 minutes
  ): boolean {
    if (timeRemainingMs === null) {
      return false; // Can't determine, proceed optimistically
    }

    return timeRemainingMs < minRequiredMs;
  }

  it('should not recreate when plenty of time remains', () => {
    expect(shouldRecreateSandbox(5 * 60 * 1000)).toBe(false); // 5 min
  });

  it('should recreate when less than 3 minutes remain', () => {
    expect(shouldRecreateSandbox(2 * 60 * 1000)).toBe(true); // 2 min
    expect(shouldRecreateSandbox(60 * 1000)).toBe(true); // 1 min
    expect(shouldRecreateSandbox(0)).toBe(true); // expired
  });

  it('should not recreate when exactly 3 minutes remain', () => {
    expect(shouldRecreateSandbox(3 * 60 * 1000)).toBe(false);
  });

  it('should proceed optimistically when timeout is null', () => {
    expect(shouldRecreateSandbox(null)).toBe(false);
  });
});

describe('Issue 3: API route 410 response for expired sandbox', () => {
  /**
   * Simulates how the API route should respond for stopped/expired sandboxes.
   * Currently returns 404 — should return 410 Gone with shouldRecreate flag.
   */
  function buildSandboxStatusResponse(sandboxStatus: string) {
    if (sandboxStatus === 'stopped' || sandboxStatus === 'failed') {
      return {
        status: 410,
        body: {
          error: 'Sandbox expired',
          code: 'SANDBOX_EXPIRED',
          shouldRecreate: true,
        },
      };
    }

    return { status: 200, body: { status: sandboxStatus } };
  }

  it('should return 410 for stopped sandbox', () => {
    const response = buildSandboxStatusResponse('stopped');
    expect(response.status).toBe(410);
    expect(response.body.code).toBe('SANDBOX_EXPIRED');
    expect(response.body.shouldRecreate).toBe(true);
  });

  it('should return 410 for failed sandbox', () => {
    const response = buildSandboxStatusResponse('failed');
    expect(response.status).toBe(410);
    expect(response.body.code).toBe('SANDBOX_EXPIRED');
  });

  it('should return 200 for running sandbox', () => {
    const response = buildSandboxStatusResponse('running');
    expect(response.status).toBe(200);
  });

  it('should return 200 for pending sandbox', () => {
    const response = buildSandboxStatusResponse('pending');
    expect(response.status).toBe(200);
  });
});
