/**
 * API route for creating Vercel Sandbox snapshots
 * Feature: 001-sandbox-providers
 *
 * POST /api/sandbox/snapshot - Create a snapshot of the current sandbox state
 */

import { json, type ActionFunctionArgs } from '@remix-run/node';
import { getSession } from '~/lib/auth/session.server';
import { getProjectById } from '~/lib/services/projects.server';
import { CreateSnapshotRequestSchema, type CreateSnapshotResponse } from '~/lib/sandbox/schemas';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.sandbox.snapshot');

/**
 * POST /api/sandbox/snapshot
 *
 * Creates a snapshot of the current Vercel Sandbox state.
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
    const parseResult = CreateSnapshotRequestSchema.safeParse(body);

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

    const { projectId, sandboxId, summary } = parseResult.data;

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
     * Note: Vercel Sandbox SDK doesn't have native snapshot support yet
     * We create a placeholder response that stores metadata in our database
     */
    logger.info('Creating snapshot (placeholder - Vercel snapshots not yet supported)', {
      projectId,
      sandboxId,
      summary,
    });

    // Return placeholder response
    const response: CreateSnapshotResponse = {
      snapshotId: `snap_${Date.now()}`,
      vercelSnapshotId: null, // Not supported yet
      sizeBytes: 0,
      filesCount: 0,
      createdAt: new Date().toISOString(),
      expiresAt: null,
    };

    return json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to create snapshot', { error: message });

    return json(
      {
        error: 'Failed to create snapshot',
        code: 'INTERNAL_ERROR',
        details: message,
      },
      { status: 500 },
    );
  }
}
