import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { action } from '~/routes/api.v2.site.bootstrap';

const mockGetSession = vi.fn();
const mockGetV2Flags = vi.fn();
const mockSearchRestaurant = vi.fn();
const mockExtractBusinessData = vi.fn();
const mockGenerateGoogleMapsMarkdown = vi.fn();
const mockCrawlWebsiteMarkdown = vi.fn();
const mockRunV2DatabasePreflight = vi.fn();
const mockGetProjectById = vi.fn();
const mockUpdateProject = vi.fn();
const mockBootstrapRun = vi.fn();

vi.mock('~/lib/auth/session.server', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

vi.mock('~/lib/config/v2Flags', () => ({
  getV2Flags: (...args: unknown[]) => mockGetV2Flags(...args),
}));

vi.mock('~/lib/services/crawlerClient.server', () => ({
  searchRestaurant: (...args: unknown[]) => mockSearchRestaurant(...args),
  extractBusinessData: (...args: unknown[]) => mockExtractBusinessData(...args),
  generateGoogleMapsMarkdown: (...args: unknown[]) => mockGenerateGoogleMapsMarkdown(...args),
  crawlWebsiteMarkdown: (...args: unknown[]) => mockCrawlWebsiteMarkdown(...args),
}));

vi.mock('~/lib/services/v2/databasePreflight.server', () => ({
  runV2DatabasePreflight: (...args: unknown[]) => mockRunV2DatabasePreflight(...args),
}));

vi.mock('~/lib/services/projects.server', () => ({
  getProjectById: (...args: unknown[]) => mockGetProjectById(...args),
  updateProject: (...args: unknown[]) => mockUpdateProject(...args),
}));

vi.mock('~/lib/mastra/factory.server', () => ({
  createMastraCore: () => ({
    mutationStrategy: { mode: 'write_file' },
    bootstrapWebsite: {
      run: (...args: unknown[]) => mockBootstrapRun(...args),
    },
    editWebsite: {
      run: vi.fn(),
    },
  }),
}));

interface ParsedSSEEvent {
  event: string;
  data: unknown;
}

function parseSSEPayload(payload: string): ParsedSSEEvent[] {
  return payload
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));

      if (!eventLine || !dataLine) {
        throw new Error(`Malformed SSE block: ${block}`);
      }

      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)),
      };
    });
}

describe('api.v2.site.bootstrap runtime persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOONSHOT_API_KEY = 'moonshot-test-key';
    process.env.E2B_API_KEY = 'e2b-test-key';
    mockGetV2Flags.mockReturnValue({
      mastraEnabled: true,
      waitingInsightsEnabled: false,
      workspaceEnabled: true,
      memoryEnabled: true,
    });
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
    mockRunV2DatabasePreflight.mockResolvedValue({
      ok: true,
      checkedAt: '2026-02-23T00:00:00.000Z',
      checks: {},
      warnings: [],
    });
    mockSearchRestaurant.mockResolvedValue({
      success: true,
      data: {
        name: 'Runtime Bistro',
        place_id: 'place-123',
        data_id: 'data-123',
        address: '123 Main St, New York',
        website: 'https://runtime.example',
      },
    });
    mockExtractBusinessData.mockResolvedValue({
      success: true,
      place_id: 'place-123',
      data: {
        website: 'https://runtime.example',
      },
    });
    mockGenerateGoogleMapsMarkdown.mockResolvedValue({
      success: true,
      place_id: 'place-123',
      markdown: '# Google Maps markdown',
    });
    mockCrawlWebsiteMarkdown.mockResolvedValue({
      success: true,
      place_id: 'place-123',
      markdown: '# Website markdown',
    });
    mockGetProjectById.mockResolvedValue({
      id: 'project-1',
      name: 'Runtime Bistro',
      business_profile: {
        place_id: 'place-123',
        v2_runtime: {
          provider: 'e2b',
          sandbox_id: 'v2-existing-sandbox',
          lifecycle: 'running',
          updated_at: '2026-02-22T00:00:00.000Z',
        },
      },
    });
    mockUpdateProject.mockResolvedValue({
      id: 'project-1',
    });
    mockBootstrapRun.mockResolvedValue({
      projectId: 'project-1',
      success: true,
      mutation: {
        mode: 'write_file',
        applied: 1,
        failures: [],
      },
      template: null,
      generatedFiles: [
        {
          path: '/app/data/content.ts',
          content: 'export const content = {};',
          size: 26,
        },
      ],
      preview: {
        port: 4173,
        url: 'https://preview.example',
        command: 'pnpm run dev -- --host 0.0.0.0 --port 4173',
      },
      runtimeSessionId: 'v2-runtime-session-1',
      buildAttempts: 1,
      warnings: [],
    });
  });

  afterEach(() => {
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.E2B_API_KEY;
  });

  it('reuses prior sandbox id and persists v2 runtime metadata', async () => {
    const request = new Request('http://localhost/api/v2/site/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-1',
        businessName: 'Runtime Bistro',
        businessAddress: '123 Main St, New York',
        sessionId: 'session-1',
      }),
    });

    const response = await action({ request } as any);
    const payload = await response.text();
    const events = parseSSEPayload(payload);
    const completed = events.find((event) => event.event === 'completed')?.data as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(mockBootstrapRun).toHaveBeenCalledTimes(1);
    expect(mockBootstrapRun.mock.calls[0][0]).toMatchObject({
      projectId: 'project-1',
      runtime: {
        workspace: {
          sandboxId: 'v2-existing-sandbox',
        },
      },
    });

    expect(mockUpdateProject).toHaveBeenCalledTimes(1);
    expect(mockUpdateProject).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      expect.objectContaining({
        business_profile: expect.objectContaining({
          v2_runtime: expect.objectContaining({
            provider: 'e2b',
            sandbox_id: 'v2-runtime-session-1',
            preview_url: 'https://preview.example',
            workspace_reused: true,
            memory: expect.objectContaining({
              enabled: true,
              resource_id: 'project:project-1',
              thread_id: 'bootstrap:session-1',
            }),
          }),
        }),
      }),
    );

    expect(completed.persistence).toEqual(
      expect.objectContaining({
        attempted: true,
        persisted: true,
        warning: null,
      }),
    );
  });
});
