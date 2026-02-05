/**
 * API route for creating Vercel Sandbox snapshots
 * Feature: 001-sandbox-providers
 *
 * POST /api/sandbox/snapshot - Create a snapshot of the current sandbox state
 */

import { json, type ActionFunctionArgs } from '@remix-run/node';
import { Sandbox } from '@vercel/sandbox';
import { getSession } from '~/lib/auth/session.server';
import { getProjectById, updateProject } from '~/lib/services/projects.server';
import { CreateSnapshotRequestSchema, type CreateSnapshotResponse } from '~/lib/sandbox/schemas';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.sandbox.snapshot');

const VERCEL_CREDS = {
  token: process.env.VERCEL_TOKEN!,
  teamId: process.env.VERCEL_TEAM_ID!,
  projectId: process.env.VERCEL_PROJECT_ID!,
};

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

    // Get the live sandbox – Sandbox.get() does not throw on stopped sandboxes
    let sandbox;

    try {
      sandbox = await Sandbox.get({ ...VERCEL_CREDS, sandboxId });
    } catch (_e) {
      return json({ error: 'Sandbox not found', code: 'SANDBOX_NOT_FOUND' }, { status: 404 });
    }

    if (sandbox.status === 'stopped' || sandbox.status === 'failed') {
      return json({ error: 'Sandbox is not running – cannot snapshot', code: 'SANDBOX_NOT_RUNNING' }, { status: 409 });
    }

    logger.info('Creating snapshot via Vercel SDK', { projectId, sandboxId, summary });

    /*
     * snapshot() captures the full filesystem + packages.
     * IMPORTANT: the sandbox stops automatically after this call.
     */
    const snapshot = await sandbox.snapshot();

    // Clear the project's sandbox reference – it is no longer usable
    await updateProject(projectId, session.user.id, {
      sandbox_id: null,
      sandbox_provider: null,
      sandbox_expires_at: null,
    });

    logger.info('Snapshot created', {
      projectId,
      sandboxId,
      snapshotId: snapshot.snapshotId,
      sizeBytes: snapshot.sizeBytes,
    });

    const response: CreateSnapshotResponse = {
      snapshotId: snapshot.snapshotId,
      vercelSnapshotId: snapshot.snapshotId,
      sizeBytes: snapshot.sizeBytes,
      filesCount: 0, // Vercel SDK does not expose a file count
      createdAt: snapshot.createdAt.toISOString(),
      expiresAt: snapshot.expiresAt.toISOString(),
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
