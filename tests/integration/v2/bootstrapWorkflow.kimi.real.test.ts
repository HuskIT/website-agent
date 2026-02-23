import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  crawlWebsiteMarkdown,
  extractBusinessData,
  generateGoogleMapsMarkdown,
  searchRestaurant,
} from '~/lib/services/crawlerClient.server';
import { createMastraCore } from '~/lib/mastra/factory.server';
import type { BusinessData, CrawlRequest, CrawlWebsiteMarkdownResponse, SearchRestaurantResponse } from '~/types/crawler';
import type { BusinessProfile } from '~/types/project';

vi.mock('~/lib/.server/telemetry/langfuse.server', () => ({
  createTrace: () => null,
  createGeneration: () => null,
  flushTraces: async () => undefined,
  isLangfuseEnabled: () => false,
}));

const shouldRunRealKimi = process.env.V2_REAL_RUN_KIMI === 'true';
const describeReal = shouldRunRealKimi ? describe : describe.skip;

function getWebsiteMarkdown(markdownResponse: CrawlWebsiteMarkdownResponse | null): string | undefined {
  if (!markdownResponse?.success) {
    return undefined;
  }

  if (typeof markdownResponse.markdown === 'string' && markdownResponse.markdown.trim().length > 0) {
    return markdownResponse.markdown;
  }

  if (typeof markdownResponse.data?.markdown === 'string' && markdownResponse.data.markdown.trim().length > 0) {
    return markdownResponse.data.markdown;
  }

  return undefined;
}

async function resolveCrawlerData(input: {
  businessName: string;
  businessAddress: string;
  mapsUrl?: string;
  sessionId: string;
}): Promise<{
  extractMethod: 'maps_url' | 'verified_place' | 'name_address';
  searchResult: SearchRestaurantResponse;
  placeId: string;
  sessionId: string;
  extractData?: BusinessData;
  googleMapsMarkdown?: string;
  websiteMarkdown?: string;
}> {
  const useMapsUrl = Boolean(input.mapsUrl?.trim());
  let searchResult: SearchRestaurantResponse = { success: false };

  if (!useMapsUrl) {
    searchResult = await searchRestaurant(input.businessName, input.businessAddress);
  }

  const extractPayload: CrawlRequest = useMapsUrl
    ? {
        session_id: input.sessionId,
        google_maps_url: input.mapsUrl?.trim(),
      }
    : searchResult.success && searchResult.data
      ? {
          session_id: input.sessionId,
          place_id: searchResult.data.place_id,
          business_name: searchResult.data.name,
          address: searchResult.data.address,
        }
      : {
          session_id: input.sessionId,
          business_name: input.businessName,
          address: input.businessAddress,
        };

  const extractResult = await extractBusinessData(extractPayload);

  if (!extractResult.success) {
    throw new Error(`Crawler extract failed: ${extractResult.error ?? 'unknown error'}`);
  }

  const placeId = extractResult.place_id || searchResult.data?.place_id;

  if (!placeId) {
    throw new Error('Crawler extract did not return place_id');
  }

  const mapsMarkdownResult = await generateGoogleMapsMarkdown(placeId);
  const websiteUrl = extractResult.data?.website || searchResult.data?.website;
  const websiteMarkdownResult = websiteUrl
    ? await crawlWebsiteMarkdown(placeId, websiteUrl, { max_pages: 1, enable_visual_analysis: true })
    : null;

  return {
    extractMethod: useMapsUrl ? 'maps_url' : searchResult.success && searchResult.data ? 'verified_place' : 'name_address',
    searchResult,
    placeId,
    sessionId: input.sessionId,
    extractData: extractResult.data,
    googleMapsMarkdown:
      mapsMarkdownResult.success && typeof mapsMarkdownResult.markdown === 'string' ? mapsMarkdownResult.markdown : undefined,
    websiteMarkdown: getWebsiteMarkdown(websiteMarkdownResult),
  };
}

describeReal('bootstrapWebsite workflow kimi autonomous real', () => {
  const originalLangfuse = process.env.LANGFUSE_ENABLED;

  beforeAll(() => {
    // Keep real run deterministic and avoid optional telemetry side effects.
    process.env.LANGFUSE_ENABLED = 'false';
  });

  afterAll(() => {
    if (originalLangfuse === undefined) {
      delete process.env.LANGFUSE_ENABLED;
      return;
    }

    process.env.LANGFUSE_ENABLED = originalLangfuse;
  });

  it(
    'generates with kimi-for-coding and returns preview URL from E2B',
    { timeout: 900_000 },
    async () => {
      const moonshotKey = process.env.MOONSHOT_API_KEY;
      const e2bApiKey = process.env.E2B_API_KEY || process.env.E2B_API_TOKEN || process.env.E2B_ACCESS_TOKEN;

      if (!moonshotKey) {
        throw new Error('Missing MOONSHOT_API_KEY for real kimi test');
      }

      if (!e2bApiKey) {
        throw new Error('Missing E2B API key for real kimi test');
      }

      const businessName = process.env.V2_STEP7_REAL_BUSINESS_NAME?.trim() || 'Starbucks Reserve Roastery New York';
      const businessAddress = process.env.V2_STEP7_REAL_BUSINESS_ADDRESS?.trim() || '61 9th Ave, New York, NY 10011';
      const mapsUrl = process.env.V2_STEP7_REAL_MAPS_URL?.trim() || undefined;
      const previewPort = Number(process.env.V2_STEP7_REAL_PREVIEW_PORT || 4173);
      const installCommand = process.env.V2_STEP7_REAL_INSTALL_COMMAND?.trim() || 'npm install';
      const buildCommand = process.env.V2_STEP7_REAL_BUILD_COMMAND?.trim() || 'npm run build';
      const sessionId = randomUUID();
      const projectId = `v2-step7-kimi-real-${Date.now()}`;

      const crawlerData = await resolveCrawlerData({
        businessName,
        businessAddress,
        mapsUrl,
        sessionId,
      });

      const businessProfile: BusinessProfile = {
        place_id: crawlerData.placeId,
        session_id: crawlerData.sessionId,
        gmaps_url: mapsUrl,
        crawled_at: new Date().toISOString(),
        crawled_data: crawlerData.extractData,
        google_maps_markdown: crawlerData.googleMapsMarkdown,
        website_markdown: crawlerData.websiteMarkdown,
      };

      const provider = {
        name: 'Moonshot',
        staticModels: [],
      };
      const mastraCore = createMastraCore();
      const workflowResult = await mastraCore.bootstrapWebsite.run(
        {
          projectId,
          businessProfile,
          generation: {
            model: 'kimi-for-coding',
            fastModel: 'kimi-for-coding',
            provider,
            fastProvider: provider,
            // selectTemplate currently calls /api/llmcall. If this URL is unreachable,
            // selectTemplate falls back safely while content generation still runs with Kimi.
            baseUrl: process.env.V2_STEP7_REAL_BASE_URL || 'http://localhost',
            cookieHeader: null,
            env: process.env as any,
            apiKeys: {
              MOONSHOT_API_KEY: moonshotKey,
            },
            providerSettings: {},
          },
          runtime: {
            workspace: {
              projectId,
              apiKey: e2bApiKey,
            },
            buildCwd: '/home/project',
            installCommand,
            buildCommand,
            maxBuildAttempts: 2,
            preview: {
              port: previewPort,
            },
          },
        },
        {
          writeFile: async () => undefined,
        },
      );

      expect(workflowResult.success).toBe(true);
      expect(workflowResult.generatedFiles?.length ?? 0).toBeGreaterThan(0);
      expect(workflowResult.preview?.url).toBeTruthy();
      expect(workflowResult.mutation.applied).toBeGreaterThan(0);

      console.log(
        JSON.stringify(
          {
            ok: true,
            projectId,
            placeId: crawlerData.placeId,
            sessionId: crawlerData.sessionId,
            extractMethod: crawlerData.extractMethod,
            template: workflowResult.template?.themeId ?? null,
            generatedFiles: workflowResult.generatedFiles?.length ?? 0,
            buildAttempts: workflowResult.buildAttempts ?? 0,
            previewUrl: workflowResult.preview?.url ?? null,
            warnings: workflowResult.warnings ?? [],
          },
          null,
          2,
        ),
      );
    },
  );
});
