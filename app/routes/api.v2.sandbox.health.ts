import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import { getSession } from '~/lib/auth/session.server';
import { getV2Flags } from '~/lib/config/v2Flags';
import { runE2BHealthProbe } from '~/lib/mastra/sandbox/e2bHealthProbe.server';

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

  const result = await runE2BHealthProbe();
  return json(result, { status: result.ok ? 200 : 502 });
}

