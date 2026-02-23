import { beforeEach, describe, expect, it, vi } from 'vitest';
import { action } from '~/routes/api.v2.database.health';

const mockGetSession = vi.fn();
const mockRunV2DatabasePreflight = vi.fn();
const mockGetV2Flags = vi.fn();

vi.mock('~/lib/auth/session.server', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

vi.mock('~/lib/services/v2/databasePreflight.server', () => ({
  runV2DatabasePreflight: (...args: unknown[]) => mockRunV2DatabasePreflight(...args),
}));

vi.mock('~/lib/config/v2Flags', () => ({
  getV2Flags: (...args: unknown[]) => mockGetV2Flags(...args),
}));

describe('api.v2.database.health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetV2Flags.mockReturnValue({
      mastraEnabled: true,
      waitingInsightsEnabled: false,
    });
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
  });

  it('returns 405 for non-POST requests', async () => {
    const request = new Request('http://localhost/api/v2/database/health', { method: 'GET' });
    const response = await action({ request } as any);

    expect(response.status).toBe(405);
  });

  it('returns 503 when V2 mastra flow is disabled', async () => {
    mockGetV2Flags.mockReturnValue({
      mastraEnabled: false,
      waitingInsightsEnabled: false,
    });

    const request = new Request('http://localhost/api/v2/database/health', { method: 'POST' });
    const response = await action({ request } as any);

    expect(response.status).toBe(503);
  });

  it('returns 401 for unauthenticated users', async () => {
    mockGetSession.mockResolvedValue(null);

    const request = new Request('http://localhost/api/v2/database/health', { method: 'POST' });
    const response = await action({ request } as any);

    expect(response.status).toBe(401);
  });

  it('returns 200 and payload when db preflight succeeds', async () => {
    mockRunV2DatabasePreflight.mockResolvedValue({
      ok: true,
      checkedAt: '2026-02-23T00:00:00.000Z',
      checks: {},
      warnings: [],
    });

    const request = new Request('http://localhost/api/v2/database/health', { method: 'POST' });
    const response = await action({ request } as any);
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('returns 503 and payload when db preflight fails', async () => {
    mockRunV2DatabasePreflight.mockResolvedValue({
      ok: false,
      checkedAt: '2026-02-23T00:00:00.000Z',
      checks: {},
      warnings: [],
      error: 'Database preflight failed for V2 bootstrap prerequisites.',
    });

    const request = new Request('http://localhost/api/v2/database/health', { method: 'POST' });
    const response = await action({ request } as any);
    const body = (await response.json()) as any;

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Database preflight failed');
  });
});
