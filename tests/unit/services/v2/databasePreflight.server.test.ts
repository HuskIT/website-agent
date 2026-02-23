import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runV2DatabasePreflight } from '~/lib/services/v2/databasePreflight.server';

const mockCreateSupabaseClient = vi.fn();

vi.mock('~/lib/db/supabase.server', () => ({
  createSupabaseClient: (...args: unknown[]) => mockCreateSupabaseClient(...args),
}));

type QueryResponse = {
  error: { message: string } | null;
};

function createMockSupabaseClient(config?: {
  queries?: Record<string, QueryResponse>;
  setCurrentUserResponse?: { data: unknown; error: { message: string } | null };
}) {
  const queries = config?.queries ?? {};
  const setCurrentUserResponse = config?.setCurrentUserResponse ?? {
    data: '00000000-0000-0000-0000-000000000000',
    error: null,
  };

  return {
    from: (table: string) => ({
      select: (columns: string) => ({
        limit: async () =>
          queries[`${table}:${columns}`] ?? {
            error: null,
          },
      }),
    }),
    rpc: async (functionName: string) => {
      if (functionName === 'set_current_user') {
        return setCurrentUserResponse;
      }

      return { data: null, error: null };
    },
  };
}

describe('runV2DatabasePreflight', () => {
  const originalEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'service-key';
  });

  afterEach(() => {
    process.env.SUPABASE_URL = originalEnv.SUPABASE_URL;
    process.env.VITE_SUPABASE_URL = originalEnv.VITE_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_KEY = originalEnv.SUPABASE_SERVICE_KEY;
  });

  it('fails when required supabase env variables are missing', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;

    const result = await runV2DatabasePreflight();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('SUPABASE_URL');
    expect(result.error).toContain('SUPABASE_SERVICE_KEY');
    expect(mockCreateSupabaseClient).not.toHaveBeenCalled();
  });

  it('passes when required tables, columns, and rpc checks are available', async () => {
    mockCreateSupabaseClient.mockReturnValue(createMockSupabaseClient());

    const result = await runV2DatabasePreflight();

    expect(result.ok).toBe(true);
    expect(result.checks.projectsTable.ok).toBe(true);
    expect(result.checks.projectSnapshotsTable.ok).toBe(true);
    expect(result.checks.businessProfileColumn.ok).toBe(true);
    expect(result.checks.setCurrentUserRpc.ok).toBe(true);
  });

  it('returns warning when optional sandbox columns are not ready', async () => {
    mockCreateSupabaseClient.mockReturnValue(
      createMockSupabaseClient({
        queries: {
          'projects:sandbox_id,sandbox_provider,sandbox_expires_at': {
            error: { message: 'column "sandbox_id" does not exist' },
          },
        },
      }),
    );

    const result = await runV2DatabasePreflight();

    expect(result.ok).toBe(true);
    expect(result.checks.sandboxColumns.ok).toBe(false);
    expect(result.warnings[0]).toContain('sandbox metadata columns');
  });

  it('fails when required projects table check fails', async () => {
    mockCreateSupabaseClient.mockReturnValue(
      createMockSupabaseClient({
        queries: {
          'projects:id': {
            error: { message: 'relation "projects" does not exist' },
          },
        },
      }),
    );

    const result = await runV2DatabasePreflight();

    expect(result.ok).toBe(false);
    expect(result.checks.projectsTable.ok).toBe(false);
    expect(result.error).toContain('Database preflight failed');
  });
});
