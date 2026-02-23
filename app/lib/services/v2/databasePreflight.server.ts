import { createSupabaseClient } from '~/lib/db/supabase.server';

const SYSTEM_CHECK_USER_ID = '00000000-0000-0000-0000-000000000000';

interface DatabaseCheckResult {
  ok: boolean;
  error?: string;
}

interface EnvironmentCheckResult {
  ok: boolean;
  missing: string[];
}

export interface V2DatabasePreflightResult {
  ok: boolean;
  checkedAt: string;
  checks: {
    env: EnvironmentCheckResult;
    projectsTable: DatabaseCheckResult;
    projectSnapshotsTable: DatabaseCheckResult;
    businessProfileColumn: DatabaseCheckResult;
    setCurrentUserRpc: DatabaseCheckResult;
    sandboxColumns: DatabaseCheckResult & { optional: true };
  };
  warnings: string[];
  error?: string;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown database error';
}

async function runCheck(action: () => Promise<void>): Promise<DatabaseCheckResult> {
  try {
    await action();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error),
    };
  }
}

function getSupabaseEnvCheck(): EnvironmentCheckResult {
  const missing: string[] = [];
  const hasSupabaseUrl = Boolean(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL);

  if (!hasSupabaseUrl) {
    missing.push('SUPABASE_URL (or VITE_SUPABASE_URL)');
  }

  if (!process.env.SUPABASE_SERVICE_KEY) {
    missing.push('SUPABASE_SERVICE_KEY');
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}

export async function runV2DatabasePreflight(): Promise<V2DatabasePreflightResult> {
  const env = getSupabaseEnvCheck();
  const checkedAt = new Date().toISOString();

  if (!env.ok) {
    return {
      ok: false,
      checkedAt,
      checks: {
        env,
        projectsTable: { ok: false, error: 'Supabase env is not configured' },
        projectSnapshotsTable: { ok: false, error: 'Supabase env is not configured' },
        businessProfileColumn: { ok: false, error: 'Supabase env is not configured' },
        setCurrentUserRpc: { ok: false, error: 'Supabase env is not configured' },
        sandboxColumns: { ok: false, optional: true, error: 'Supabase env is not configured' },
      },
      warnings: [],
      error: `Missing required environment variables: ${env.missing.join(', ')}`,
    };
  }

  let client: ReturnType<typeof createSupabaseClient>;

  try {
    client = createSupabaseClient();
  } catch (error) {
    const message = toErrorMessage(error);
    console.error('[v2.databasePreflight] Failed to create Supabase client for V2 preflight', { error: message });

    return {
      ok: false,
      checkedAt,
      checks: {
        env,
        projectsTable: { ok: false, error: message },
        projectSnapshotsTable: { ok: false, error: message },
        businessProfileColumn: { ok: false, error: message },
        setCurrentUserRpc: { ok: false, error: message },
        sandboxColumns: { ok: false, optional: true, error: message },
      },
      warnings: [],
      error: message,
    };
  }

  const projectsTable = await runCheck(async () => {
    const { error } = await client.from('projects').select('id').limit(1);

    if (error) {
      throw new Error(error.message);
    }
  });

  const projectSnapshotsTable = await runCheck(async () => {
    const { error } = await client.from('project_snapshots').select('id').limit(1);

    if (error) {
      throw new Error(error.message);
    }
  });

  const businessProfileColumn = await runCheck(async () => {
    const { error } = await client.from('projects').select('business_profile').limit(1);

    if (error) {
      throw new Error(error.message);
    }
  });

  const setCurrentUserRpc = await runCheck(async () => {
    const { data, error } = await client.rpc('set_current_user', {
      user_id: SYSTEM_CHECK_USER_ID,
    });

    if (error) {
      throw new Error(error.message);
    }

    if (typeof data !== 'string' || data !== SYSTEM_CHECK_USER_ID) {
      throw new Error('set_current_user returned an unexpected value');
    }
  });

  // Optional for current step; required once sandbox metadata persistence is enabled.
  const sandboxColumns = await runCheck(async () => {
    const { error } = await client.from('projects').select('sandbox_id,sandbox_provider,sandbox_expires_at').limit(1);

    if (error) {
      throw new Error(error.message);
    }
  });

  const warnings: string[] = [];

  if (!sandboxColumns.ok) {
    warnings.push('Optional sandbox metadata columns are not ready yet (projects.sandbox_*).');
  }

  const ok = env.ok && projectsTable.ok && projectSnapshotsTable.ok && businessProfileColumn.ok && setCurrentUserRpc.ok;

  const result: V2DatabasePreflightResult = {
    ok,
    checkedAt,
    checks: {
      env,
      projectsTable,
      projectSnapshotsTable,
      businessProfileColumn,
      setCurrentUserRpc,
      sandboxColumns: {
        optional: true,
        ...sandboxColumns,
      },
    },
    warnings,
  };

  if (!ok) {
    console.error('[v2.databasePreflight] V2 database preflight failed', {
      checks: result.checks,
      warnings: result.warnings,
    });
    result.error = 'Database preflight failed for V2 bootstrap prerequisites.';
  }

  return result;
}
