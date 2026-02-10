/**
 * API route for getting Vercel Sandbox status
 *
 * GET /api/sandbox/status?projectId=xxx&sandboxId=xxx - Get sandbox status
 */

import { json, type LoaderFunctionArgs } from '@remix-run/node';
import { Sandbox } from '@vercel/sandbox';
import { getSession } from '~/lib/auth/session.server';
import { getProjectById } from '~/lib/services/projects.server';
import { GetSandboxStatusRequestSchema, type GetSandboxStatusResponse } from '~/lib/sandbox/schemas';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.sandbox.status');

const VERCEL_CREDS = {
  token: process.env.VERCEL_TOKEN!,
  teamId: process.env.VERCEL_TEAM_ID!,
  projectId: process.env.VERCEL_PROJECT_ID!,
};

/**
 * GET /api/sandbox/status
 *
 * Gets the status of a Vercel Sandbox session.
 * Requires authentication and project ownership.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  // Check if Vercel Sandbox is enabled
  if (process.env.SANDBOX_VERCEL_ENABLED === 'false') {
    return json({ error: 'Vercel Sandbox is disabled', code: 'FEATURE_DISABLED' }, { status: 503 });
  }

  try {
    // Authenticate
    const session = await getSession(request);

    if (!session?.user) {
      return json({ error: 'Authentication required', code: 'UNAUTHORIZED' }, { status: 401 });
    }

    // Parse query parameters
    const url = new URL(request.url);
    const queryParams = {
      projectId: url.searchParams.get('projectId'),
      sandboxId: url.searchParams.get('sandboxId'),
    };

    const parseResult = GetSandboxStatusRequestSchema.safeParse(queryParams);

    if (!parseResult.success) {
      return json(
        {
          error: 'Invalid query parameters',
          code: 'INVALID_INPUT',
          details: parseResult.error.issues,
        },
        { status: 400 },
      );
    }

    const { projectId, sandboxId } = parseResult.data;

    // Verify project ownership
    const project = await getProjectById(projectId, session.user.id);

    if (!project) {
      return json({ error: 'Project not found', code: 'NOT_FOUND' }, { status: 404 });
    }

    // Verify the sandbox belongs to this project
    if (project.sandbox_id !== sandboxId) {
      return json({ error: 'Sandbox does not belong to this project', code: 'FORBIDDEN' }, { status: 403 });
    }

    // Get sandbox status – Sandbox.get() does not throw on stopped sandboxes
    try {
      const sandbox = await Sandbox.get({ ...VERCEL_CREDS, sandboxId });

      logger.debug('Got sandbox status', { projectId, sandboxId, status: sandbox.status });

      const response: GetSandboxStatusResponse = {
        sandboxId,
        status: sandbox.status as GetSandboxStatusResponse['status'],
        timeout: sandbox.timeout,
        expiresAt: new Date(Date.now() + sandbox.timeout).toISOString(),
      };

      return json(response);
    } catch (_e) {
      logger.info('Sandbox not found (get threw)', { projectId, sandboxId });

      return json({ error: 'Sandbox not found or expired', code: 'SANDBOX_NOT_FOUND' }, { status: 404 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to get sandbox status', { error: message });

    return json(
      {
        error: 'Failed to get sandbox status',
        code: 'INTERNAL_ERROR',
        details: message,
      },
      { status: 500 },
    );
  }
}
