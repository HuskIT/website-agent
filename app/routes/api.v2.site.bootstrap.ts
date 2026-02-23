import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from '@remix-run/node';
import { getSession } from '~/lib/auth/session.server';
import { getV2Flags } from '~/lib/config/v2Flags';
import {
  V2BootstrapRequestSchema,
  V2BootstrapSSEEventSchema,
  type V2BootstrapRequest,
  type V2BootstrapSSEEvent,
} from '~/lib/services/v2/contracts';

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

function buildBootstrapMilestones(input: V2BootstrapRequest): V2BootstrapSSEEvent[] {
  const projectId = input.projectId ?? null;
  const businessName = input.businessName ?? null;
  const businessAddress = input.businessAddress ?? null;
  const placeId = input.placeId ?? input.businessProfile?.place_id ?? null;

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
      mode: 'stub',
      nextStep: 'step5_real_crawler',
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
      readyFor: 'step5_crawler_integration',
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

  const milestones = buildBootstrapMilestones(parsedBody.data);
  const stream = new ReadableStream({
    start(controller) {
      try {
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
