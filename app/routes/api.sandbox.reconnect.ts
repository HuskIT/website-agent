/**
 * API route for reconnecting to an existing Vercel Sandbox session
 *
 * POST /api/sandbox/reconnect - Reconnect to existing sandbox for a project
 */

import { json, type ActionFunctionArgs } from '@remix-run/node';
import { Sandbox } from '@vercel/sandbox';
import { getSession } from '~/lib/auth/session.server';
import { getProjectById } from '~/lib/services/projects.server';
import { ReconnectSandboxRequestSchema, type ReconnectSandboxResponse } from '~/lib/sandbox/schemas';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.sandbox.reconnect');

const VERCEL_CREDS = {
  token: process.env.VERCEL_TOKEN!,
  teamId: process.env.VERCEL_TEAM_ID!,
  projectId: process.env.VERCEL_PROJECT_ID!,
};

/**
 * POST /api/sandbox/reconnect
 *
 * Reconnects to an existing Vercel Sandbox session for a project.
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
    const parseResult = ReconnectSandboxRequestSchema.safeParse(body);

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

    const { projectId, sandboxId, ports } = parseResult.data;

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
     * Try to reconnect to existing sandbox.
     * Sandbox.get() does NOT throw on stopped/snapshotting sandboxes – check status explicitly.
     */
    let sandbox;

    try {
      sandbox = await Sandbox.get({ ...VERCEL_CREDS, sandboxId });
    } catch (_e) {
      logger.info('Sandbox not found (get threw)', { projectId, sandboxId });
      return json({ error: 'Sandbox session not found or expired', code: 'SANDBOX_NOT_FOUND' }, { status: 404 });
    }

    if (sandbox.status === 'stopped' || sandbox.status === 'failed' || sandbox.status === 'snapshotting') {
      logger.info('Sandbox no longer usable', { projectId, sandboxId, status: sandbox.status });
      return json({ error: 'Sandbox session expired or stopped', code: 'SANDBOX_NOT_RUNNING' }, { status: 404 });
    }

    // Get preview URLs for each port
    const previewUrls: Record<number, string> = {};

    for (const port of ports) {
      try {
        previewUrls[port] = sandbox.domain(port);
      } catch {
        // Port not exposed, skip
      }
    }

    logger.info('Reconnected to sandbox', { projectId, sandboxId, status: sandbox.status });

    const response: ReconnectSandboxResponse = {
      success: true,
      sandboxId,
      status: sandbox.status as 'pending' | 'running',
      previewUrls,
      timeout: sandbox.timeout,
      connectedAt: new Date().toISOString(),
    };

    return json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to reconnect to sandbox', { error: message });

    return json(
      {
        error: 'Failed to reconnect to sandbox',
        code: 'INTERNAL_ERROR',
        details: message,
      },
      { status: 500 },
    );
  }
}
