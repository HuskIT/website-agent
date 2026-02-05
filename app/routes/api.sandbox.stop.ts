/**
 * API route for stopping a Vercel Sandbox session
 *
 * POST /api/sandbox/stop - Stop sandbox for a project
 */

import { json, type ActionFunctionArgs } from '@remix-run/node';
import { getSession } from '~/lib/auth/session.server';
import { getProjectById, updateProject } from '~/lib/services/projects.server';
import { StopSandboxRequestSchema, type StopSandboxResponse } from '~/lib/sandbox/schemas';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.sandbox.stop');

/**
 * POST /api/sandbox/stop
 *
 * Stops a Vercel Sandbox session for a project.
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
    const parseResult = StopSandboxRequestSchema.safeParse(body);

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

    const { projectId, sandboxId, createSnapshot } = parseResult.data;

    // Verify project ownership
    const project = await getProjectById(projectId, session.user.id);

    if (!project) {
      return json({ error: 'Project not found', code: 'NOT_FOUND' }, { status: 404 });
    }

    // Verify the sandbox belongs to this project
    if (project.sandbox_id !== sandboxId) {
      return json({ error: 'Sandbox does not belong to this project', code: 'FORBIDDEN' }, { status: 403 });
    }

    /*
     * Note: Vercel Sandbox doesn't have a direct stop method in the SDK
     * The sandbox will timeout automatically after the timeout period
     * We can only clear the project reference to it
     */

    logger.info('Stopping sandbox (clearing project reference)', {
      projectId,
      sandboxId,
      createSnapshot,
    });

    // Clear sandbox info from project (use snake_case for DB columns)
    await updateProject(projectId, session.user.id, {
      sandbox_id: null,
      sandbox_provider: null,
      sandbox_expires_at: null,
    });

    // Note: Vercel Sandbox doesn't have snapshot API yet, so snapshotId is always null
    const response: StopSandboxResponse = {
      success: true,
      snapshotId: null,
    };

    return json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to stop sandbox', { error: message });

    return json(
      {
        error: 'Failed to stop sandbox',
        code: 'INTERNAL_ERROR',
        details: message,
      },
      { status: 500 },
    );
  }
}
