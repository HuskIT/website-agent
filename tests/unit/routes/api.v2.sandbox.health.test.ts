import { describe, expect, it, beforeEach, vi } from 'vitest';
import { action } from '~/routes/api.v2.sandbox.health';

const mockGetSession = vi.fn();
const mockRunE2BHealthProbe = vi.fn();
const mockGetV2Flags = vi.fn();

vi.mock('~/lib/auth/session.server', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

vi.mock('~/lib/mastra/sandbox/e2bHealthProbe.server', () => ({
  runE2BHealthProbe: (...args: unknown[]) => mockRunE2BHealthProbe(...args),
}));

vi.mock('~/lib/config/v2Flags', () => ({
  getV2Flags: (...args: unknown[]) => mockGetV2Flags(...args),
}));

describe('api.v2.sandbox.health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetV2Flags.mockReturnValue({
      mastraEnabled: true,
      waitingInsightsEnabled: false,
    });
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
  });

  it('returns 405 for non-POST requests', async () => {
    const request = new Request('http://localhost/api/v2/sandbox/health', { method: 'GET' });
    const response = await action({ request } as any);

    expect(response.status).toBe(405);
  });

  it('returns 503 when V2 mastra flow is disabled', async () => {
    mockGetV2Flags.mockReturnValue({
      mastraEnabled: false,
      waitingInsightsEnabled: false,
    });

    const request = new Request('http://localhost/api/v2/sandbox/health', { method: 'POST' });
    const response = await action({ request } as any);

    expect(response.status).toBe(503);
  });

  it('returns 401 for unauthenticated users', async () => {
    mockGetSession.mockResolvedValue(null);

    const request = new Request('http://localhost/api/v2/sandbox/health', { method: 'POST' });
    const response = await action({ request } as any);

    expect(response.status).toBe(401);
  });

  it('returns 200 and probe payload when probe succeeds', async () => {
    mockRunE2BHealthProbe.mockResolvedValue({
      ok: true,
      provider: 'e2b',
      nodeVersion: 'v22.12.0',
      sandboxId: 'sbx-123',
      latencyMs: 80,
    });

    const request = new Request('http://localhost/api/v2/sandbox/health', { method: 'POST' });
    const response = await action({ request } as any);
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.provider).toBe('e2b');
    expect(body.nodeVersion).toBe('v22.12.0');
  });

  it('returns 502 and probe payload when probe fails', async () => {
    mockRunE2BHealthProbe.mockResolvedValue({
      ok: false,
      provider: 'e2b',
      latencyMs: 12,
      error: 'E2B SDK is not installed',
    });

    const request = new Request('http://localhost/api/v2/sandbox/health', { method: 'POST' });
    const response = await action({ request } as any);
    const body = (await response.json()) as any;

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('E2B');
  });
});
