import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from '@remix-run/node';
import { getApiKeysFromCookie, getProviderSettingsFromCookie } from '~/lib/api/cookies';
import { getSession } from '~/lib/auth/session.server';
import { getV2Flags } from '~/lib/config/v2Flags';
import { createMastraCore } from '~/lib/mastra/factory.server';
import { buildBootstrapMemoryScope } from '~/lib/mastra/memory/scope';
import {
  crawlWebsiteMarkdown,
  extractBusinessData,
  generateGoogleMapsMarkdown,
  searchRestaurant,
} from '~/lib/services/crawlerClient.server';
import { getProjectById, updateProject } from '~/lib/services/projects.server';
import { adaptBootstrapInput } from '~/lib/services/v2/bootstrapInputAdapter';
import { runV2DatabasePreflight } from '~/lib/services/v2/databasePreflight.server';
import {
  buildV2RuntimeState,
  mergeBusinessProfileRuntime,
  readV2RuntimeState,
} from '~/lib/services/v2/runtimeMetadata';
import {
  V2BootstrapRequestSchema,
  V2BootstrapSSEEventSchema,
  type V2BootstrapRequest,
  type V2BootstrapSSEEvent,
} from '~/lib/services/v2/contracts';
import type {
  BusinessData,
  CrawlRequest,
  CrawlWebsiteMarkdownResponse,
  SearchRestaurantResponse,
} from '~/types/crawler';
import type { BusinessProfile, ProjectWithDetails } from '~/types/project';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '~/utils/constants';

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
  data: {
    placeId: string;
    sessionId: string;
    googleMapsMarkdown?: string;
    websiteMarkdown?: string;
    extractData?: BusinessData;
  },
  baseProfile?: BusinessProfile | null,
): Pick<ProjectWithDetails, 'id' | 'name' | 'business_profile'> | null {
  if (!input.projectId) {
    return null;
  }

  return {
    id: input.projectId,
    name: input.businessName ?? 'Untitled Business',
    business_profile: {
      ...(baseProfile ?? {}),
      place_id: data.placeId,
      session_id: data.sessionId,
      gmaps_url: input.mapsUrl ?? input.businessProfile?.gmaps_url,
      crawled_at: new Date().toISOString(),
      crawled_data: data.extractData,
      google_maps_markdown: data.googleMapsMarkdown,
      website_markdown: data.websiteMarkdown,
    },
  };
}

function buildSeedOperations(params: {
  placeId: string;
  sessionId: string;
  googleMapsMarkdown?: string;
  websiteMarkdown?: string;
  businessName?: string;
  businessAddress?: string;
}): Array<{ path: string; content: string }> {
  return [
    {
      path: '/app/data/google-maps.md',
      content: params.googleMapsMarkdown || '# Google Maps markdown unavailable',
    },
    {
      path: '/app/data/website.md',
      content: params.websiteMarkdown || '# Website markdown unavailable',
    },
    {
      path: '/app/data/business-profile.json',
      content: JSON.stringify(
        {
          businessName: params.businessName ?? null,
          businessAddress: params.businessAddress ?? null,
          placeId: params.placeId,
          sessionId: params.sessionId,
        },
        null,
        2,
      ),
    },
  ];
}

async function resolveCrawlerData(input: V2BootstrapRequest): Promise<{
  searchResult: SearchRestaurantResponse;
  extractMethod: 'maps_url' | 'verified_place' | 'name_address';
  placeId: string;
  sessionId: string;
  extractData?: BusinessData;
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
    extractData: extractResult.data,
    googleMapsMarkdown:
      mapsMarkdownResult.success && typeof mapsMarkdownResult.markdown === 'string'
        ? mapsMarkdownResult.markdown
        : undefined,
    websiteMarkdown: getWebsiteMarkdown(websiteMarkdownResult),
  };
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
        const requestedProjectId = parsedBody.data.projectId;
        const existingProject = requestedProjectId ? await getProjectById(requestedProjectId, session.user.id) : null;
        const existingBusinessProfile = existingProject?.business_profile ?? null;
        const previousRuntimeState =
          readV2RuntimeState(existingBusinessProfile) ||
          readV2RuntimeState(parsedBody.data.businessProfile as BusinessProfile | undefined);
        const crawlerData = await resolveCrawlerData(parsedBody.data);
        const projectCandidate = buildProjectAdapterInput(parsedBody.data, crawlerData, existingBusinessProfile);
        const adaptedInput = adaptBootstrapInput({
          project: projectCandidate,
          searchResult:
            crawlerData.searchResult.success && crawlerData.searchResult.data ? crawlerData.searchResult.data : null,
          extractPayload: {
            place_id: crawlerData.placeId,
            session_id: crawlerData.sessionId,
            google_maps_markdown: crawlerData.googleMapsMarkdown,
            website_markdown: crawlerData.websiteMarkdown,
          },
          fallback: {
            businessName: parsedBody.data.businessName,
            businessAddress: parsedBody.data.businessAddress,
            mapsUrl: parsedBody.data.mapsUrl,
            sessionId: crawlerData.sessionId,
            placeId: crawlerData.placeId,
          },
        });

        const workflowProjectId = adaptedInput.projectId ?? parsedBody.data.projectId ?? crypto.randomUUID();
        const memoryScope = flags.memoryEnabled
          ? buildBootstrapMemoryScope(workflowProjectId, crawlerData.sessionId)
          : undefined;
        const reusableSandboxId = flags.workspaceEnabled ? previousRuntimeState?.sandbox_id : undefined;
        const workspaceReuseRequested = Boolean(reusableSandboxId);
        const businessProfile: BusinessProfile = {
          place_id: adaptedInput.placeId ?? adaptedInput.businessProfile?.place_id,
          session_id: adaptedInput.sessionId ?? adaptedInput.businessProfile?.session_id,
          gmaps_url: parsedBody.data.mapsUrl ?? adaptedInput.mapsUrl ?? adaptedInput.businessProfile?.gmaps_url,
          crawled_at: new Date().toISOString(),
          crawled_data: crawlerData.extractData,
          google_maps_markdown: crawlerData.googleMapsMarkdown ?? adaptedInput.businessProfile?.google_maps_markdown,
          website_markdown: crawlerData.websiteMarkdown ?? adaptedInput.businessProfile?.website_markdown,
        };
        const cookieHeader = request.headers.get('Cookie');
        const apiKeys = getApiKeysFromCookie(cookieHeader);
        const providerSettings = getProviderSettingsFromCookie(cookieHeader);
        const hasMoonshotKey = Boolean(apiKeys.MOONSHOT_API_KEY || process.env.MOONSHOT_API_KEY);
        const hasE2BKey = Boolean(process.env.E2B_API_KEY || process.env.E2B_API_TOKEN || process.env.E2B_ACCESS_TOKEN);
        const hasWorkspaceRuntime = flags.workspaceEnabled && hasE2BKey;
        const shouldRunAutonomous = Boolean(businessProfile.google_maps_markdown && hasMoonshotKey);
        const provider = {
          name: DEFAULT_PROVIDER?.name ?? 'Moonshot',
          staticModels: [],
        };
        const baseUrl = new URL(request.url).origin;
        const workflowInput = shouldRunAutonomous
          ? {
              projectId: workflowProjectId,
              businessProfile,
              generation: {
                model: DEFAULT_MODEL,
                provider,
                baseUrl,
                cookieHeader,
                env: process.env as any,
                apiKeys,
                providerSettings,
              },
              runtime: hasWorkspaceRuntime
                ? {
                    workspace: {
                      projectId: workflowProjectId,
                      sandboxId: reusableSandboxId,
                    },
                    buildCwd: '/home/project',
                    installCommand: 'pnpm install',
                    buildCommand: 'pnpm run build',
                    maxBuildAttempts: 2,
                    preview: {
                      port: 4173,
                    },
                  }
                : undefined,
            }
          : {
              projectId: workflowProjectId,
              operations: buildSeedOperations({
                placeId: crawlerData.placeId,
                sessionId: crawlerData.sessionId,
                googleMapsMarkdown: crawlerData.googleMapsMarkdown,
                websiteMarkdown: crawlerData.websiteMarkdown,
                businessName: adaptedInput.businessName,
                businessAddress: adaptedInput.businessAddress,
              }),
            };
        const mastraCore = createMastraCore();
        const inMemoryWrites = new Map<string, string>();

        controller.enqueue(
          toSSEChunk(
            createStubEvent('input_validated', {
              projectId: workflowProjectId,
              businessName: adaptedInput.businessName ?? null,
              businessAddress: adaptedInput.businessAddress ?? null,
              placeId: adaptedInput.placeId ?? adaptedInput.businessProfile?.place_id ?? null,
              contractVersion: 'v2',
            }),
          ),
        );
        controller.enqueue(
          toSSEChunk(
            createStubEvent('crawler_started', {
              projectId: workflowProjectId,
              mode: 'real',
              extractMethod: crawlerData.extractMethod,
              searchSuccess: crawlerData.searchResult.success,
              hasGoogleMapsMarkdown: Boolean(crawlerData.googleMapsMarkdown),
              hasWebsiteMarkdown: Boolean(crawlerData.websiteMarkdown),
            }),
          ),
        );
        controller.enqueue(
          toSSEChunk(
            createStubEvent('generation_started', {
              projectId: workflowProjectId,
              mode: shouldRunAutonomous ? 'mastra_autonomous' : 'mastra_seed',
              strategy: mastraCore.mutationStrategy.mode,
              hasE2BSandbox: hasWorkspaceRuntime,
              workspaceEnabled: flags.workspaceEnabled,
              workspaceReuseRequested,
              memoryEnabled: flags.memoryEnabled,
              memoryScope: memoryScope ?? null,
            }),
          ),
        );

        const workflowResult = await mastraCore.bootstrapWebsite.run(workflowInput, {
          writeFile: async (filePath: string, content: string) => {
            inMemoryWrites.set(filePath, content);
          },
        });
        const persistenceProjectId = requestedProjectId ?? adaptedInput.projectId ?? null;
        let persistenceWarning: string | null = null;
        let runtimePersisted = false;

        if (persistenceProjectId) {
          const runtimeState = buildV2RuntimeState({
            sandboxId: workflowResult.runtimeSessionId ?? reusableSandboxId,
            workspaceId: `v2-${workflowProjectId}`,
            sessionId: crawlerData.sessionId,
            previewUrl: workflowResult.preview?.url ?? null,
            lifecycle: workflowResult.preview?.url ? 'running' : workflowResult.success ? 'completed' : 'failed',
            workspaceReused: workspaceReuseRequested,
            buildAttempts: workflowResult.buildAttempts ?? 0,
            warnings: workflowResult.warnings ?? [],
            memory: memoryScope
              ? {
                  enabled: true,
                  resource_id: memoryScope.resourceId,
                  thread_id: memoryScope.threadId,
                }
              : {
                  enabled: false,
                },
          });
          const profileWithRuntime = mergeBusinessProfileRuntime(businessProfile, runtimeState);

          try {
            await updateProject(persistenceProjectId, session.user.id, {
              business_profile: profileWithRuntime,
            });
            runtimePersisted = true;
          } catch (error) {
            persistenceWarning = error instanceof Error ? error.message : 'Failed to persist V2 runtime state';
          }
        }

        controller.enqueue(
          toSSEChunk(
            createStubEvent('preview_starting', {
              projectId: workflowProjectId,
              provider: workflowResult.preview?.url ? 'e2b' : 'none',
              previewUrl: workflowResult.preview?.url ?? null,
            }),
          ),
        );
        controller.enqueue(
          toSSEChunk(
            createStubEvent('completed', {
              projectId: workflowProjectId,
              status: workflowResult.success ? 'completed' : 'completed_with_warnings',
              mode: shouldRunAutonomous ? 'mastra_autonomous' : 'mastra_seed',
              template: workflowResult.template ?? null,
              previewUrl: workflowResult.preview?.url ?? null,
              mutation: {
                mode: workflowResult.mutation.mode,
                applied: workflowResult.mutation.applied,
                failures: workflowResult.mutation.failures.length,
              },
              generatedFiles: workflowResult.generatedFiles?.length ?? inMemoryWrites.size,
              buildAttempts: workflowResult.buildAttempts ?? 0,
              warnings: persistenceWarning
                ? [...(workflowResult.warnings ?? []), `runtime_persistence_warning: ${persistenceWarning}`]
                : (workflowResult.warnings ?? []),
              placeId: crawlerData.placeId,
              sessionId: crawlerData.sessionId,
              runtime: {
                provider: workflowResult.preview?.url ? 'e2b' : 'none',
                runtimeSessionId: workflowResult.runtimeSessionId ?? null,
                workspaceReuseRequested,
                sandboxId: workflowResult.runtimeSessionId ?? reusableSandboxId ?? null,
              },
              persistence: {
                attempted: Boolean(persistenceProjectId),
                projectId: persistenceProjectId,
                persisted: runtimePersisted,
                warning: persistenceWarning,
              },
              memoryScope: memoryScope ?? null,
              markdown: {
                googleMapsLength: crawlerData.googleMapsMarkdown?.length ?? 0,
                websiteLength: crawlerData.websiteMarkdown?.length ?? 0,
              },
            }),
          ),
        );
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
