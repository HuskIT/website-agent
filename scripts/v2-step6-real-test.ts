import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { createMastraCore } from '../app/lib/mastra/factory.server';
import {
  crawlWebsiteMarkdown,
  extractBusinessData,
  generateGoogleMapsMarkdown,
  searchRestaurant,
} from '../app/lib/services/crawlerClient.server';
import type { BusinessData, CrawlWebsiteMarkdownResponse, SearchRestaurantResponse } from '../app/types/crawler';

loadEnv({ path: '.env' });
loadEnv({ path: '.env.local', override: true });

const DEFAULT_BUSINESS_NAME = 'Starbucks Reserve Roastery New York';
const DEFAULT_BUSINESS_ADDRESS = '61 9th Ave, New York, NY 10011';
const DEFAULT_PREVIEW_PORT = 4173;

function resolveE2BApiKey(): string | undefined {
  return process.env.E2B_API_KEY || process.env.E2B_API_TOKEN || process.env.E2B_ACCESS_TOKEN;
}

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

function createPreviewCommand(port: number): string {
  const program = `
const http = require('node:http');
const fs = require('node:fs');
const file = '/home/user/index.html';
http
  .createServer((_req, res) => {
    try {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  })
  .listen(${port}, '0.0.0.0');
`;

  return `node -e ${JSON.stringify(program)}`;
}

function createBuildCommand(): string {
  return `node -e ${JSON.stringify("console.log('step6 build check ok')")}`;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildHtmlPreview(params: {
  businessName: string;
  businessAddress: string;
  placeId: string;
  sessionId: string;
  googleMapsMarkdown?: string;
  websiteMarkdown?: string;
}): string {
  const mapsSummary = escapeHtml((params.googleMapsMarkdown || '').slice(0, 1500) || 'No Google Maps markdown available');
  const websiteSummary = escapeHtml((params.websiteMarkdown || '').slice(0, 1200) || 'No website markdown available');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(params.businessName)} - V2 Step 6 Real Test</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f4ee;
        --card: #fffaf1;
        --text: #1f1a14;
        --muted: #6d6359;
        --accent: #bb4d00;
      }

      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background: linear-gradient(145deg, #fff7e9 0%, var(--bg) 60%, #f2ebdf 100%);
        color: var(--text);
      }

      .shell {
        max-width: 1100px;
        margin: 0 auto;
        padding: 32px 24px 64px;
      }

      .card {
        background: var(--card);
        border: 1px solid #e8ddcc;
        border-radius: 20px;
        padding: 24px;
        margin-bottom: 20px;
      }

      h1 {
        margin: 0 0 8px;
        line-height: 1.1;
      }

      h2 {
        margin: 0 0 12px;
        font-size: 20px;
      }

      .meta {
        color: var(--muted);
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 16px;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 999px;
        padding: 6px 12px;
        background: #ffe8d7;
        color: var(--accent);
        font-size: 13px;
        font-weight: 600;
      }

      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 13px;
        line-height: 1.45;
        color: #352d24;
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="card">
        <div class="badge">Mastra + E2B Step 6 Real Test</div>
        <h1>${escapeHtml(params.businessName)}</h1>
        <p>${escapeHtml(params.businessAddress)}</p>
        <div class="meta">
          <span>Place ID: ${escapeHtml(params.placeId)}</span>
          <span>Session: ${escapeHtml(params.sessionId)}</span>
        </div>
      </section>
      <section class="card">
        <h2>Google Maps Markdown (excerpt)</h2>
        <pre>${mapsSummary}</pre>
      </section>
      <section class="card">
        <h2>Website Markdown (excerpt)</h2>
        <pre>${websiteSummary}</pre>
      </section>
    </main>
  </body>
</html>`;
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

  const extractPayload = useMapsUrl
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

async function main(): Promise<void> {
  const startedAt = Date.now();
  const apiKey = resolveE2BApiKey();
  const businessName = process.env.V2_STEP6_REAL_BUSINESS_NAME?.trim() || DEFAULT_BUSINESS_NAME;
  const businessAddress = process.env.V2_STEP6_REAL_BUSINESS_ADDRESS?.trim() || DEFAULT_BUSINESS_ADDRESS;
  const mapsUrl = process.env.V2_STEP6_REAL_MAPS_URL?.trim() || undefined;
  const previewPort = Number(process.env.V2_STEP6_REAL_PREVIEW_PORT || DEFAULT_PREVIEW_PORT);
  const projectId = process.env.V2_STEP6_REAL_PROJECT_ID?.trim() || `v2-step6-real-${Date.now()}`;
  const sessionId = randomUUID();

  if (!apiKey) {
    throw new Error('Missing E2B API key (set E2B_API_KEY, E2B_API_TOKEN, or E2B_ACCESS_TOKEN)');
  }

  const crawlerData = await resolveCrawlerData({
    businessName,
    businessAddress,
    mapsUrl,
    sessionId,
  });

  const htmlPreview = buildHtmlPreview({
    businessName,
    businessAddress,
    placeId: crawlerData.placeId,
    sessionId: crawlerData.sessionId,
    googleMapsMarkdown: crawlerData.googleMapsMarkdown,
    websiteMarkdown: crawlerData.websiteMarkdown,
  });

  const seedFiles = [
    {
      path: '/home/user/index.html',
      content: htmlPreview,
    },
    {
      path: '/home/user/data/google-maps.md',
      content: crawlerData.googleMapsMarkdown || '# Google Maps markdown unavailable',
    },
    {
      path: '/home/user/data/website.md',
      content: crawlerData.websiteMarkdown || '# Website markdown unavailable',
    },
    {
      path: '/home/user/data/business-profile.json',
      content: JSON.stringify(
        {
          businessName,
          businessAddress,
          placeId: crawlerData.placeId,
          sessionId: crawlerData.sessionId,
          extractMethod: crawlerData.extractMethod,
          searchSuccess: crawlerData.searchResult.success,
          hasGoogleMapsMarkdown: Boolean(crawlerData.googleMapsMarkdown),
          hasWebsiteMarkdown: Boolean(crawlerData.websiteMarkdown),
        },
        null,
        2,
      ),
    },
  ];

  const mastraCore = createMastraCore();
  const workflowResult = await mastraCore.bootstrapWebsite.run(
    {
      projectId,
      operations: seedFiles,
      runtime: {
        workspace: {
          projectId,
          apiKey,
        },
        buildCwd: '/home/user',
        installCommand: '',
        buildCommand: createBuildCommand(),
        maxBuildAttempts: 2,
        preview: {
          port: previewPort,
          cwd: '/home/user',
          command: createPreviewCommand(previewPort),
        },
      },
    },
    {
      writeFile: async () => undefined,
    },
  );

  if (!workflowResult.preview?.url) {
    throw new Error('Step 6 real test failed: preview URL was not returned');
  }

  if (workflowResult.mutation.applied < 1) {
    throw new Error('Step 6 real test failed: no files were written to sandbox');
  }

  const summary = {
    ok: true,
    projectId,
    placeId: crawlerData.placeId,
    sessionId: crawlerData.sessionId,
    extractMethod: crawlerData.extractMethod,
    filesWritten: workflowResult.mutation.applied,
    buildAttempts: workflowResult.buildAttempts ?? 0,
    previewUrl: workflowResult.preview.url,
    warnings: workflowResult.warnings ?? [],
    markdown: {
      googleMapsLength: crawlerData.googleMapsMarkdown?.length ?? 0,
      websiteLength: crawlerData.websiteMarkdown?.length ?? 0,
    },
    timingMs: Date.now() - startedAt,
  };

  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: message,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
