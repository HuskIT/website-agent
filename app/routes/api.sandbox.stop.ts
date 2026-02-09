/**
 * API route for stopping a Vercel Sandbox session
 *
 * POST /api/sandbox/stop - Stop sandbox for a project
 */

import { json, type ActionFunctionArgs } from '@remix-run/node';
import { Sandbox } from '@vercel/sandbox';
import { getSession } from '~/lib/auth/session.server';
import {
  getProjectById,
  updateProject,
  getLatestProjectSnapshot,
  updateProjectSnapshot,
} from '~/lib/services/projects.server';
import { StopSandboxRequestSchema, type StopSandboxResponse } from '~/lib/sandbox/schemas';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.sandbox.stop');

const VERCEL_CREDS = {
  token: process.env.VERCEL_TOKEN!,
  teamId: process.env.VERCEL_TEAM_ID!,
  projectId: process.env.VERCEL_PROJECT_ID!,
};

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

    /*
     * Parse and validate request body
     * Handle both JSON (regular fetch) and text/plain (navigator.sendBeacon)
     */
    const contentType = request.headers.get('Content-Type') || '';
    let body: unknown;

    if (contentType.includes('application/json')) {
      body = await request.json();
    } else {
      // sendBeacon sends as text/plain
      const text = await request.text();
      body = JSON.parse(text);
    }

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

    let snapshotId: string | null = null;

    // Get the live sandbox
    let sandbox;

    try {
      sandbox = await Sandbox.get({ ...VERCEL_CREDS, sandboxId });
    } catch (_e) {
      // Already gone – just clear DB and return success
      logger.info('Sandbox already gone, clearing project reference', { projectId, sandboxId });
    }

    if (sandbox && sandbox.status !== 'stopped' && sandbox.status !== 'failed') {
      if (createSnapshot) {
        // snapshot() stops the sandbox automatically – no need to call stop() afterwards
        try {
          logger.info('Creating snapshot before stop', { projectId, sandboxId });

          const snap = await sandbox.snapshot();
          snapshotId = snap.snapshotId;
          logger.info('Snapshot created', { projectId, sandboxId, snapshotId });

          /*
           * Save Vercel snapshot ID to database for fast restore on next session
           * This enables restoring from snapshot instead of full file upload + npm install
           */
          try {
            console.log('💾 Saving Vercel snapshot ID to database:', { projectId, snapshotId });

            const latestSnapshot = await getLatestProjectSnapshot(projectId, session.user.id);

            if (latestSnapshot) {
              console.log('💾 Found latest snapshot:', { snapshotId: latestSnapshot.id, projectId });
              await updateProjectSnapshot(latestSnapshot.id, { vercel_snapshot_id: snapshotId }, session.user.id);
              logger.info('Vercel snapshot ID saved to database', { projectId, snapshotId });
              console.log('✅ Vercel snapshot ID saved successfully:', { projectId, snapshotId });
            } else {
              console.warn('⚠️ No project snapshot found to save Vercel snapshot ID', { projectId, snapshotId });
              logger.warn('No project snapshot found to save Vercel snapshot ID', { projectId, snapshotId });
            }
          } catch (dbError) {
            // Non-fatal: snapshot was created but DB update failed
            console.error('❌ Failed to save Vercel snapshot ID to database:', {
              projectId,
              snapshotId,
              error: dbError,
            });
            logger.warn('Failed to save Vercel snapshot ID to database', {
              projectId,
              snapshotId,
              error: dbError,
            });
          }
        } catch (snapErr) {
          // Snapshot failed – fall through to explicit stop
          logger.warn('Snapshot before stop failed, calling stop()', { projectId, sandboxId, error: snapErr });
          await sandbox.stop();
        }
      } else {
        await sandbox.stop();
      }
    }

    // Clear sandbox reference from project (but keep snapshot reference)
    await updateProject(projectId, session.user.id, {
      sandbox_id: null,
      sandbox_provider: null,
      sandbox_expires_at: null,

      // Note: vercel_snapshot_id is stored in project_snapshots table, not projects table
    });

    logger.info('Sandbox stopped', { projectId, sandboxId, snapshotId });

    const response: StopSandboxResponse = {
      success: true,
      snapshotId,
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
