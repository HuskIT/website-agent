/**
 * API route for restoring Vercel Sandbox from a snapshot
 * Feature: 001-sandbox-providers
 *
 * POST /api/sandbox/snapshot/:id/restore - Restore sandbox from a snapshot
 */

import { json, type ActionFunctionArgs } from '@remix-run/node';
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { getSession } from '~/lib/auth/session.server';
import { getProjectById, updateProject } from '~/lib/services/projects.server';
import { RestoreSnapshotRequestSchema, type RestoreSnapshotResponse } from '~/lib/sandbox/schemas';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.sandbox.snapshot.restore');

const VERCEL_CREDS = {
  token: process.env.VERCEL_TOKEN!,
  teamId: process.env.VERCEL_TEAM_ID!,
  projectId: process.env.VERCEL_PROJECT_ID!,
};

/**
 * POST /api/sandbox/snapshot/:id/restore
 *
 * Restores a Vercel Sandbox from a snapshot.
 * Requires authentication and project ownership.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  // Check if Vercel Sandbox is enabled
  if (process.env.SANDBOX_VERCEL_ENABLED === 'false') {
    return json({ error: 'Vercel Sandbox is disabled', code: 'FEATURE_DISABLED' }, { status: 503 });
  }

  // Check method
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  }

  const { id: snapshotId } = params;

  if (!snapshotId) {
    return json({ error: 'Snapshot ID is required', code: 'INVALID_INPUT' }, { status: 400 });
  }

  try {
    // Authenticate
    const session = await getSession(request);

    if (!session?.user) {
      return json({ error: 'Authentication required', code: 'UNAUTHORIZED' }, { status: 401 });
    }

    // Parse and validate request body
    const body = (await request.json()) as Record<string, unknown>;
    const parseResult = RestoreSnapshotRequestSchema.safeParse({
      ...body,
      snapshotId,
    });

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

    const { projectId, useVercelSnapshot } = parseResult.data;

    // Verify project ownership
    const project = await getProjectById(projectId, session.user.id);

    if (!project) {
      return json({ error: 'Project not found', code: 'NOT_FOUND' }, { status: 404 });
    }

    logger.info('Restoring sandbox from snapshot', { projectId, snapshotId, useVercelSnapshot });

    if (useVercelSnapshot) {
      // Verify the snapshot still exists and is valid
      let snapshot;

      try {
        snapshot = await Snapshot.get({ ...VERCEL_CREDS, snapshotId });
      } catch (_e) {
        return json({ error: 'Snapshot not found', code: 'SNAPSHOT_NOT_FOUND' }, { status: 404 });
      }

      // Snapshot.get() returns { status: "deleted" } instead of throwing after deletion
      if (snapshot.status === 'deleted' || snapshot.status === 'failed') {
        return json({ error: 'Snapshot is no longer available', code: 'SNAPSHOT_EXPIRED' }, { status: 404 });
      }

      // Create a new sandbox from the snapshot – this is the fast-start path
      const sandbox = await Sandbox.create({
        ...VERCEL_CREDS,
        source: { type: 'snapshot', snapshotId },
        runtime: 'node22',
        timeout: 10 * 60 * 1000, // 10 min default
        ports: [3000, 5173],
      });

      // Collect preview URLs for exposed ports
      const previewUrls: Record<number, string> = {};

      for (const port of [3000, 5173]) {
        try {
          previewUrls[port] = sandbox.domain(port);
        } catch {
          // Port not exposed, skip
        }
      }

      // Persist the new sandbox reference on the project
      await updateProject(projectId, session.user.id, {
        sandbox_id: sandbox.sandboxId,
        sandbox_provider: 'vercel',
        sandbox_expires_at: new Date(Date.now() + sandbox.timeout),
      });

      logger.info('Sandbox restored from snapshot', {
        projectId,
        snapshotId,
        newSandboxId: sandbox.sandboxId,
      });

      const response: RestoreSnapshotResponse = {
        success: true,
        sandboxId: sandbox.sandboxId,
        restoredFrom: 'vercel_snapshot',
        previewUrls,
      };

      return json(response);
    }

    // Fallback: no Vercel snapshot – caller should use writeFiles to populate
    return json({ error: 'Non-Vercel restore not supported via this route', code: 'UNSUPPORTED' }, { status: 501 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to restore snapshot', { error: message });

    return json(
      {
        error: 'Failed to restore snapshot',
        code: 'INTERNAL_ERROR',
        details: message,
      },
      { status: 500 },
    );
  }
}
