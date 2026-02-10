/**
 * API route for extending Vercel Sandbox timeout
 *
 * POST /api/sandbox/extend - Extend sandbox timeout
 */

import { json, type ActionFunctionArgs } from '@remix-run/node';
import { Sandbox } from '@vercel/sandbox';
import { getSession } from '~/lib/auth/session.server';
import { getProjectById, updateProject } from '~/lib/services/projects.server';
import { ExtendTimeoutRequestSchema, type ExtendTimeoutResponse } from '~/lib/sandbox/schemas';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.sandbox.extend');

const VERCEL_CREDS = {
  token: process.env.VERCEL_TOKEN!,
  teamId: process.env.VERCEL_TEAM_ID!,
  projectId: process.env.VERCEL_PROJECT_ID!,
};

/**
 * POST /api/sandbox/extend
 *
 * Extends the timeout of a Vercel Sandbox session.
 * Requires authentication and project ownership.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Check if Vercel Sandbox is enabled
  if (process.env.SANDBOX_VERCEL_ENABLED === 'false') {
    return json({ error: 'Vercel Sandbox is disabled', code: 'FEATURE_DISABLED' }, { status: 503 });
  }

  // Check method
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  }

  try {
    // Authenticate
    const session = await getSession(request);

    if (!session?.user) {
      return json({ error: 'Authentication required', code: 'UNAUTHORIZED' }, { status: 401 });
    }

    // Parse and validate request body
    const body = await request.json();
    const parseResult = ExtendTimeoutRequestSchema.safeParse(body);

    if (!parseResult.success) {
      return json(
        {
          error: 'Invalid request body',
          code: 'INVALID_INPUT',
          details: parseResult.error.issues,
        },
        { status: 400 },
      );
    }

    const { projectId, sandboxId, duration } = parseResult.data;

    // Verify project ownership
    const project = await getProjectById(projectId, session.user.id);

    if (!project) {
      return json({ error: 'Project not found', code: 'NOT_FOUND' }, { status: 404 });
    }

    // Verify the sandbox belongs to this project
    if (project.sandbox_id !== sandboxId) {
      return json({ error: 'Sandbox does not belong to this project', code: 'FORBIDDEN' }, { status: 403 });
    }

    // Get sandbox and extend timeout via SDK
    try {
      const sandbox = await Sandbox.get({ ...VERCEL_CREDS, sandboxId });

      if (sandbox.status === 'stopped' || sandbox.status === 'failed') {
        return json({ error: 'Sandbox not running', code: 'SANDBOX_NOT_RUNNING' }, { status: 404 });
      }

      // Call the real SDK method – extends the microVM timeout server-side
      await sandbox.extendTimeout(duration);

      // sandbox.timeout is stale after extendTimeout; re-fetch to get the real value
      const refreshed = await Sandbox.get({ ...VERCEL_CREDS, sandboxId });
      const newExpiresAt = new Date(Date.now() + refreshed.timeout);

      // Keep our DB record in sync
      await updateProject(projectId, session.user.id, {
        sandbox_expires_at: newExpiresAt,
      });

      logger.info('Extended sandbox timeout', { projectId, sandboxId, duration, newTimeout: refreshed.timeout });

      const response: ExtendTimeoutResponse = {
        success: true,
        newTimeout: refreshed.timeout,
        expiresAt: newExpiresAt.toISOString(),
      };

      return json(response);
    } catch (e) {
      logger.error('Failed to extend sandbox timeout', { projectId, sandboxId, error: e });

      return json({ error: 'Failed to extend timeout', code: 'EXTENSION_FAILED' }, { status: 500 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to extend sandbox timeout', { error: message });

    return json(
      {
        error: 'Failed to extend sandbox timeout',
        code: 'INTERNAL_ERROR',
        details: message,
      },
      { status: 500 },
    );
  }
}
