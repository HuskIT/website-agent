import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from '@remix-run/node';
import { getSession } from '~/lib/auth/session.server';
import { getV2Flags } from '~/lib/config/v2Flags';
import {
  crawlWebsiteMarkdown,
  extractBusinessData,
  generateGoogleMapsMarkdown,
  searchRestaurant,
} from '~/lib/services/crawlerClient.server';
import { adaptBootstrapInput } from '~/lib/services/v2/bootstrapInputAdapter';
import { runV2DatabasePreflight } from '~/lib/services/v2/databasePreflight.server';
import {
  V2BootstrapRequestSchema,
  V2BootstrapSSEEventSchema,
  type V2BootstrapRequest,
  type V2BootstrapSSEEvent,
} from '~/lib/services/v2/contracts';
import type { CrawlRequest, CrawlWebsiteMarkdownResponse, SearchRestaurantResponse } from '~/types/crawler';
import type { ProjectWithDetails } from '~/types/project';

const encoder = new TextEncoder();

function toSSEChunk(event: V2BootstrapSSEEvent): Uint8Array {
  return encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

function createStubEvent(event: V2BootstrapSSEEvent['event'], data: Record<string, unknown>): V2BootstrapSSEEvent {
  return V2BootstrapSSEEventSchema.parse({
    event,
    data,
  });
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

function buildProjectAdapterInput(
  input: V2BootstrapRequest,
): Pick<ProjectWithDetails, 'id' | 'name' | 'business_profile'> | null {
  if (!input.projectId) {
    return null;
  }

  return {
    id: input.projectId,
    name: input.businessName ?? 'Untitled Business',
  };
}

async function resolveCrawlerData(input: V2BootstrapRequest): Promise<{
  searchResult: SearchRestaurantResponse;
  extractMethod: 'maps_url' | 'verified_place' | 'name_address';
  placeId: string;
  sessionId: string;
  googleMapsMarkdown?: string;
  websiteMarkdown?: string;
}> {
  const sessionId = input.sessionId ?? crypto.randomUUID();
  const useMapsUrl = Boolean(input.mapsUrl?.trim());

  let searchResult: SearchRestaurantResponse = { success: false };

  if (!useMapsUrl && input.businessName && input.businessAddress) {
    searchResult = await searchRestaurant(input.businessName, input.businessAddress);
  }

  const extractPayload: CrawlRequest = useMapsUrl
    ? {
        session_id: sessionId,
        google_maps_url: input.mapsUrl?.trim(),
      }
    : searchResult.success && searchResult.data
      ? {
          session_id: sessionId,
          place_id: searchResult.data.place_id,
          business_name: searchResult.data.name,
          address: searchResult.data.address,
        }
      : {
          session_id: sessionId,
          business_name: input.businessName,
          address: input.businessAddress,
        };

  const extractResult = await extractBusinessData(extractPayload);

  if (!extractResult.success) {
    throw new Error(extractResult.error ?? 'Crawler extraction failed');
  }

  const placeId =
    extractResult.place_id || searchResult.data?.place_id || input.placeId || input.businessProfile?.place_id;

  if (!placeId) {
    throw new Error('Crawler extract did not return place_id');
  }

  const mapsMarkdownResult = await generateGoogleMapsMarkdown(placeId);
  const websiteUrl = extractResult.data?.website || searchResult.data?.website;
  const websiteMarkdownResult = websiteUrl
    ? await crawlWebsiteMarkdown(placeId, websiteUrl, { max_pages: 1, enable_visual_analysis: true })
    : null;

  return {
    searchResult,
    extractMethod: useMapsUrl
      ? 'maps_url'
      : searchResult.success && searchResult.data
        ? 'verified_place'
        : 'name_address',
    placeId,
    sessionId,
    googleMapsMarkdown:
      mapsMarkdownResult.success && typeof mapsMarkdownResult.markdown === 'string'
        ? mapsMarkdownResult.markdown
        : undefined,
    websiteMarkdown: getWebsiteMarkdown(websiteMarkdownResult),
  };
}

function buildBootstrapMilestones(
  input: V2BootstrapRequest,
  data: Awaited<ReturnType<typeof resolveCrawlerData>>,
): V2BootstrapSSEEvent[] {
  const projectCandidate = buildProjectAdapterInput(input);
  const adaptedInput = adaptBootstrapInput({
    project: projectCandidate,
    searchResult: data.searchResult.success && data.searchResult.data ? data.searchResult.data : null,
    extractPayload: {
      place_id: data.placeId,
      session_id: data.sessionId,
      google_maps_markdown: data.googleMapsMarkdown,
      website_markdown: data.websiteMarkdown,
    },
    fallback: {
      businessName: input.businessName,
      businessAddress: input.businessAddress,
      mapsUrl: input.mapsUrl,
      sessionId: data.sessionId,
      placeId: data.placeId,
    },
  });

  const projectId = adaptedInput.projectId ?? null;
  const businessName = adaptedInput.businessName ?? null;
  const businessAddress = adaptedInput.businessAddress ?? null;
  const placeId = adaptedInput.placeId ?? adaptedInput.businessProfile?.place_id ?? null;

  return [
    createStubEvent('input_validated', {
      projectId,
      businessName,
      businessAddress,
      placeId,
      contractVersion: 'v2',
    }),
    createStubEvent('crawler_started', {
      projectId,
      mode: 'real',
      extractMethod: data.extractMethod,
      searchSuccess: data.searchResult.success,
      hasGoogleMapsMarkdown: Boolean(data.googleMapsMarkdown),
      hasWebsiteMarkdown: Boolean(data.websiteMarkdown),
    }),
    createStubEvent('generation_started', {
      projectId,
      mode: 'stub',
      strategy: 'write_file',
      nextStep: 'step6_mastra_bootstrap',
    }),
    createStubEvent('preview_starting', {
      projectId,
      provider: 'stub',
      nextStep: 'step7_preview_persistence',
    }),
    createStubEvent('completed', {
      projectId,
      status: 'stub_completed',
      readyFor: 'step6_mastra_bootstrap',
      placeId,
      sessionId: data.sessionId,
      markdown: {
        googleMapsLength: data.googleMapsMarkdown?.length ?? 0,
        websiteLength: data.websiteMarkdown?.length ?? 0,
      },
    }),
  ];
}

export async function loader(_request: LoaderFunctionArgs) {
  return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST' } }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST method is allowed' } }, { status: 405 });
  }

  const flags = getV2Flags();

  if (!flags.mastraEnabled) {
    return json(
      {
        error: {
          code: 'FEATURE_DISABLED',
          message: 'V2 Mastra flow is disabled. Set V2_MASTRA_ENABLED=true to enable.',
        },
      },
      { status: 503 },
    );
  }

  const session = await getSession(request);

  if (!session?.user?.id) {
    return json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  }

  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } }, { status: 400 });
  }

  const parsedBody = V2BootstrapRequestSchema.safeParse(rawBody);

  if (!parsedBody.success) {
    return json(
      {
        error: {
          code: 'INVALID_INPUT',
          message: parsedBody.error.issues[0]?.message ?? 'Invalid bootstrap input.',
          details: parsedBody.error.flatten(),
        },
      },
      { status: 400 },
    );
  }

  const dbPreflight = await runV2DatabasePreflight();

  if (!dbPreflight.ok) {
    return json(
      {
        error: {
          code: 'DATABASE_NOT_READY',
          message: dbPreflight.error ?? 'V2 database preflight failed.',
          details: dbPreflight,
        },
      },
      { status: 503 },
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const crawlerData = await resolveCrawlerData(parsedBody.data);
        const milestones = buildBootstrapMilestones(parsedBody.data, crawlerData);

        for (const event of milestones) {
          controller.enqueue(toSSEChunk(event));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to stream bootstrap milestones';
        const errorEvent = createStubEvent('error', { message });
        controller.enqueue(toSSEChunk(errorEvent));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
