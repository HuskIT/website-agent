import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createMastraCore } from '../app/lib/mastra/factory.server';
import type { FileMutationOperation } from '../app/lib/mastra/strategies/fileMutation';
import { adaptBootstrapInput } from '../app/lib/services/v2/bootstrapInputAdapter';
import { adaptBootstrapOutput } from '../app/lib/services/v2/bootstrapOutputAdapter';
import { V2BootstrapRequestSchema, V2BootstrapSSEEventSchema } from '../app/lib/services/v2/contracts';
import type { GeneratedFile } from '../app/types/generation';
import type { ProjectWithDetails } from '../app/types/project';
import type {
  CrawlRequest,
  CrawlResponse,
  CrawlWebsiteMarkdownResponse,
  GenerateGoogleMapsMarkdownResponse,
  SearchRestaurantResponse,
  VerifiedRestaurantData,
} from '../app/types/crawler';

loadEnv({ path: '.env' });
loadEnv({ path: '.env.local', override: true });

const CRAWLER_API_URL = process.env.CRAWLER_API_URL || 'http://localhost:4999';
const REQUEST_TIMEOUT_MS = Number(process.env.V2_REAL_TEST_TIMEOUT_MS || 180_000);

function readErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const body = payload as Record<string, unknown>;

    if (typeof body.error === 'string') {
      return body.error;
    }

    if (typeof body.message === 'string') {
      return body.message;
    }

    if (body.error && typeof body.error === 'object') {
      const nested = body.error as Record<string, unknown>;
      if (typeof nested.message === 'string') {
        return nested.message;
      }
    }
  }

  return fallback;
}

async function postCrawler(endpoint: string, body: unknown): Promise<{ status: number; payload: unknown }> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${CRAWLER_API_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
    const payload = (await response.json()) as unknown;

    return {
      status: response.status,
      payload,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        status: 408,
        payload: {
          success: false,
          error: `Request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        },
      };
    }

    return {
      status: 503,
      payload: {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function searchRestaurantReal(businessName: string, address: string): Promise<SearchRestaurantResponse> {
  const { status, payload } = await postCrawler('/search-restaurant', {
    business_name: businessName,
    address,
  });
  const asResponse = payload as Partial<SearchRestaurantResponse>;

  if (status >= 200 && status < 300 && typeof asResponse.success === 'boolean') {
    return {
      success: asResponse.success,
      data: asResponse.data,
      error: asResponse.error,
      statusCode: status,
    };
  }

  return {
    success: false,
    error: readErrorMessage(payload, `search-restaurant failed (${status})`),
    statusCode: status,
  };
}

async function extractBusinessDataReal(payload: CrawlRequest): Promise<CrawlResponse> {
  const { status, payload: rawPayload } = await postCrawler('/crawl', payload);
  const asResponse = rawPayload as Partial<CrawlResponse>;

  if (status >= 200 && status < 300 && typeof asResponse.success === 'boolean') {
    return {
      success: asResponse.success,
      place_id: asResponse.place_id,
      session_id: asResponse.session_id,
      data: asResponse.data,
      error: asResponse.error,
      statusCode: status,
    };
  }

  return {
    success: false,
    place_id: payload.place_id,
    session_id: payload.session_id,
    error: readErrorMessage(rawPayload, `crawl failed (${status})`),
    statusCode: status,
  };
}

async function generateGoogleMapsMarkdownReal(placeId: string): Promise<GenerateGoogleMapsMarkdownResponse> {
  const { status, payload } = await postCrawler('/generate-google-maps-markdown', {
    place_id: placeId,
  });
  const asResponse = payload as Partial<GenerateGoogleMapsMarkdownResponse>;

  if (status >= 200 && status < 300 && typeof asResponse.success === 'boolean') {
    return {
      success: asResponse.success,
      place_id: asResponse.place_id || placeId,
      session_id: asResponse.session_id,
      markdown: asResponse.markdown,
      error: asResponse.error,
      statusCode: status,
    };
  }

  return {
    success: false,
    place_id: placeId,
    error: readErrorMessage(payload, `generate-google-maps-markdown failed (${status})`),
    statusCode: status,
  };
}

async function crawlWebsiteMarkdownReal(placeId: string, url: string): Promise<CrawlWebsiteMarkdownResponse> {
  const { status, payload } = await postCrawler('/crawl-website-markdown', {
    place_id: placeId,
    url,
    max_pages: 1,
    enable_visual_analysis: true,
  });
  const asResponse = payload as Partial<CrawlWebsiteMarkdownResponse>;

  if (status >= 200 && status < 300 && typeof asResponse.success === 'boolean') {
    return {
      success: asResponse.success,
      place_id: asResponse.place_id || placeId,
      markdown: asResponse.markdown,
      data: asResponse.data,
      error: asResponse.error,
      statusCode: status,
    };
  }

  return {
    success: false,
    place_id: placeId,
    error: readErrorMessage(payload, `crawl-website-markdown failed (${status})`),
    statusCode: status,
  };
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

function toGeneratedFiles(operations: FileMutationOperation[]): GeneratedFile[] {
  return operations
    .filter((operation): operation is FileMutationOperation & { content: string } => typeof operation.content === 'string')
    .map((operation) => ({
      path: operation.path,
      content: operation.content,
      size: Buffer.byteLength(operation.content, 'utf8'),
    }));
}

async function writeToSandboxWorkspace(rootDir: string, filePath: string, content: string): Promise<void> {
  const cleanPath = filePath.replace(/^\/+/, '');
  const absolutePath = path.join(rootDir, cleanPath);
  const directory = path.dirname(absolutePath);

  await mkdir(directory, { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const businessName = process.env.V2_REAL_TEST_BUSINESS_NAME?.trim() || 'Starbucks';
  const businessAddress = process.env.V2_REAL_TEST_BUSINESS_ADDRESS?.trim() || 'New York, NY';
  const mapsUrl = process.env.V2_REAL_TEST_MAPS_URL?.trim() || undefined;
  const keepWorkspace = process.env.V2_REAL_TEST_KEEP_FILES === 'true';
  const sessionId = randomUUID();
  const projectId = `v2-real-phase012-${Date.now()}`;

  const phase0Input = V2BootstrapRequestSchema.parse({
    projectId,
    businessName,
    businessAddress,
    sessionId,
    mapsUrl,
  });
  const phase0Event = V2BootstrapSSEEventSchema.parse({
    event: 'input_validated',
    data: {
      projectId,
      businessName,
      businessAddress,
    },
  });

  const searchResult = await searchRestaurantReal(businessName, businessAddress);
  const verifiedRestaurant: VerifiedRestaurantData | null = searchResult.success && searchResult.data ? searchResult.data : null;

  const extractionPayload = mapsUrl
    ? { session_id: sessionId, google_maps_url: mapsUrl }
    : verifiedRestaurant
      ? {
          session_id: sessionId,
          place_id: verifiedRestaurant.place_id,
          business_name: verifiedRestaurant.name,
          address: verifiedRestaurant.address,
        }
      : { session_id: sessionId, business_name: businessName, address: businessAddress };

  const extractResult = await extractBusinessDataReal(extractionPayload);

  if (!extractResult.success) {
    throw new Error(
      `Crawler extract failed (${extractResult.statusCode ?? 'unknown'}): ${extractResult.error ?? 'unknown error'}`,
    );
  }

  const placeId = extractResult.place_id || verifiedRestaurant?.place_id;

  if (!placeId) {
    throw new Error('Crawler extract did not return place_id');
  }

  const mapsMarkdownResult = await generateGoogleMapsMarkdownReal(placeId);
  const websiteUrl = extractResult.data?.website || verifiedRestaurant?.website;
  const websiteMarkdownResult = websiteUrl
    ? await crawlWebsiteMarkdownReal(placeId, websiteUrl)
    : null;

  const googleMapsMarkdown =
    mapsMarkdownResult.success && typeof mapsMarkdownResult.markdown === 'string' ? mapsMarkdownResult.markdown : undefined;
  const websiteMarkdown = getWebsiteMarkdown(websiteMarkdownResult);

  const adapterProject: Pick<ProjectWithDetails, 'id' | 'name' | 'business_profile'> = {
    id: projectId,
    name: verifiedRestaurant?.name || businessName,
    business_profile: {
      place_id: placeId,
      session_id: sessionId,
      gmaps_url: mapsUrl,
      crawled_at: new Date().toISOString(),
      crawled_data: extractResult.data,
      google_maps_markdown: googleMapsMarkdown,
      website_markdown: websiteMarkdown,
    },
  };

  const adaptedInput = adaptBootstrapInput({
    project: adapterProject,
    searchResult: verifiedRestaurant,
    extractPayload: {
      place_id: placeId,
      session_id: sessionId,
      google_maps_markdown: googleMapsMarkdown,
      website_markdown: websiteMarkdown,
    },
    fallback: {
      businessName,
      businessAddress,
      mapsUrl,
      sessionId,
      placeId,
    },
  });

  const phase1Input = V2BootstrapRequestSchema.parse(adaptedInput);
  const mastraCore = createMastraCore();

  const sandboxWorkspace = await mkdtemp(path.join(tmpdir(), 'v2-phase012-real-'));
  const mutationOperations: FileMutationOperation[] = [
    {
      path: '/app/data/google-maps.md',
      content: googleMapsMarkdown || '# Google Maps markdown unavailable',
    },
    {
      path: '/app/data/website.md',
      content: websiteMarkdown || '# Website markdown unavailable',
    },
    {
      path: '/app/data/business-profile.json',
      content: JSON.stringify(
        {
          businessName: phase1Input.businessName,
          businessAddress: phase1Input.businessAddress,
          placeId: phase1Input.placeId,
          websiteUrl: websiteUrl || null,
          hasWebsiteMarkdown: Boolean(websiteMarkdown),
        },
        null,
        2,
      ),
    },
  ];

  const fileContext = {
    writeFile: async (filePath: string, content: string) => writeToSandboxWorkspace(sandboxWorkspace, filePath, content),
  };

  const bootstrapMutation = await mastraCore.bootstrapWebsite.run(
    {
      projectId,
      operations: mutationOperations,
    },
    fileContext,
  );

  const editMutation = await mastraCore.editWebsite.run(
    {
      projectId,
      prompt: 'Update hero content from verified business profile',
      operations: [
        {
          path: '/app/data/edit-note.txt',
          content: `edit executed for ${projectId} at ${new Date().toISOString()}`,
        },
      ],
    },
    fileContext,
  );

  const generatedFiles = toGeneratedFiles(mutationOperations);
  const phase1Output = adaptBootstrapOutput({
    projectId,
    streamedFiles: generatedFiles,
    warnings: [
      ...(mapsMarkdownResult.success ? [] : [`google_maps_markdown_failed:${mapsMarkdownResult.error ?? 'unknown'}`]),
      ...(websiteMarkdownResult && !websiteMarkdownResult.success
        ? [`website_markdown_failed:${websiteMarkdownResult.error ?? 'unknown'}`]
        : []),
    ],
  });

  const samplePath = path.join(sandboxWorkspace, 'app', 'data', 'business-profile.json');
  const sampleFile = await readFile(samplePath, 'utf8');

  const summary = {
    ok: true,
    inputs: {
      businessName,
      businessAddress,
      mapsUrl: mapsUrl || null,
      crawlerApiUrl: process.env.CRAWLER_API_URL || 'http://localhost:4999',
      projectId,
      sessionId,
    },
    phase0: {
      contractValidated: Boolean(phase0Input),
      eventValidated: Boolean(phase0Event),
    },
    phase1: {
      search: {
        success: searchResult.success,
        statusCode: searchResult.statusCode || null,
        placeId: searchResult.data?.place_id || null,
        error: searchResult.error || null,
      },
      extract: {
        success: extractResult.success,
        statusCode: extractResult.statusCode || null,
        placeId,
        hasBusinessData: Boolean(extractResult.data),
        hasWebsite: Boolean(websiteUrl),
      },
      markdown: {
        googleMaps: {
          success: mapsMarkdownResult.success,
          length: googleMapsMarkdown?.length || 0,
          error: mapsMarkdownResult.error || null,
        },
        website: {
          attempted: Boolean(websiteUrl),
          success: Boolean(websiteMarkdown),
          length: websiteMarkdown?.length || 0,
          error: websiteMarkdownResult && !websiteMarkdownResult.success ? websiteMarkdownResult.error || null : null,
        },
      },
      adapter: {
        projectId: phase1Input.projectId || null,
        businessName: phase1Input.businessName || null,
        businessAddress: phase1Input.businessAddress || null,
        placeId: phase1Input.placeId || null,
        hasBusinessProfile: Boolean(phase1Input.businessProfile),
      },
      outputAdapter: {
        success: phase1Output.success,
        files: phase1Output.files.length,
        warnings: phase1Output.warnings || [],
      },
    },
    phase2: {
      mutationMode: mastraCore.mutationStrategy.mode,
      bootstrap: {
        success: bootstrapMutation.success,
        applied: bootstrapMutation.mutation.applied,
        failures: bootstrapMutation.mutation.failures.length,
      },
      edit: {
        success: editMutation.success,
        applied: editMutation.mutation.applied,
        failures: editMutation.mutation.failures.length,
      },
      workspace: sandboxWorkspace,
      sampleFileBytes: Buffer.byteLength(sampleFile, 'utf8'),
    },
    durationMs: Date.now() - startedAt,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!keepWorkspace) {
    await rm(sandboxWorkspace, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
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
