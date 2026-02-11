/**
 * API route for creating a new Vercel Sandbox session
 *
 * POST /api/sandbox/create - Create a new sandbox for a project
 */

import { json, type ActionFunctionArgs } from '@remix-run/node';
import { Sandbox } from '@vercel/sandbox';
import { getSession } from '~/lib/auth/session.server';
import { getProjectById, updateProject } from '~/lib/services/projects.server';
import { CreateSandboxRequestSchema, type CreateSandboxResponse } from '~/lib/sandbox/schemas';
import { createScopedLogger } from '~/utils/logger';

// Vercel credentials from environment
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;

const logger = createScopedLogger('api.sandbox.create');

// Log if credentials are missing
if (!VERCEL_TOKEN) {
  logger.warn('VERCEL_TOKEN is not set in environment');
}

if (!VERCEL_TEAM_ID) {
  logger.warn('VERCEL_TEAM_ID is not set in environment');
}

if (!VERCEL_PROJECT_ID) {
  logger.warn('VERCEL_PROJECT_ID is not set in environment');
}

/**
 * POST /api/sandbox/create
 *
 * Creates a new Vercel Sandbox session for a project.
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
    const parseResult = CreateSandboxRequestSchema.safeParse(body);

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

    const { projectId, snapshotId, runtime, ports, timeout } = parseResult.data;

    // Verify project ownership
    const project = await getProjectById(projectId, session.user.id);

    if (!project) {
      return json({ error: 'Project not found', code: 'NOT_FOUND' }, { status: 404 });
    }

    /*
     * Check if there's an existing sandbox session.
     * Sandbox.get() does NOT throw on stopped sandboxes – check status explicitly.
     */
    if (project.sandbox_id) {
      try {
        const existingSandbox = await Sandbox.get({
          sandboxId: project.sandbox_id,
          token: VERCEL_TOKEN,
          teamId: VERCEL_TEAM_ID,
          projectId: VERCEL_PROJECT_ID,
        });

        if (existingSandbox.status === 'running' || existingSandbox.status === 'pending') {
          const previewUrls: Record<number, string> = {};

          for (const port of ports) {
            try {
              previewUrls[port] = existingSandbox.domain(port);
            } catch {
              // Port not exposed, skip
            }
          }

          logger.info('Reconnected to existing sandbox', {
            projectId,
            sandboxId: project.sandbox_id,
            status: existingSandbox.status,
          });

          return json({
            sandboxId: project.sandbox_id,
            status: existingSandbox.status as 'pending' | 'running',
            previewUrls,
            timeout: existingSandbox.timeout,
            createdAt: new Date().toISOString(),
          } satisfies CreateSandboxResponse);
        }

        // Sandbox exists but is stopped/snapshotting – fall through to create a new one
        logger.info('Existing sandbox no longer usable, creating new', {
          projectId,
          oldSandboxId: project.sandbox_id,
          status: existingSandbox.status,
        });
      } catch (_e) {
        // Sandbox.get threw – truly gone
        logger.info('Existing sandbox not found, creating new', { projectId, oldSandboxId: project.sandbox_id });
      }
    }

    // Create new Vercel Sandbox
    logger.info('Creating new Vercel Sandbox', {
      projectId,
      runtime,
      ports,
      timeout,
      teamId: VERCEL_TEAM_ID,
      vercelProjectId: VERCEL_PROJECT_ID,
      hasToken: !!VERCEL_TOKEN,
    });

    /*
     * Build sandbox options with explicit credentials
     * Based on working test: tests/vercel-sandbox-test.ts
     */
    const sandboxOptions: any = snapshotId
      ? {
          source: { type: 'snapshot' as const, snapshotId },
          timeout,
          ports,
          token: VERCEL_TOKEN,
          teamId: VERCEL_TEAM_ID,
          projectId: VERCEL_PROJECT_ID,
        }
      : {
          timeout,
          ports,
          runtime: (runtime || 'node22') as 'node22' | 'node24' | 'python3.13',
          token: VERCEL_TOKEN,
          teamId: VERCEL_TEAM_ID,
          projectId: VERCEL_PROJECT_ID,
        };

    let sandbox;

    try {
      logger.info('Calling Sandbox.create', {
        hasToken: !!sandboxOptions.token,
        hasTeamId: !!sandboxOptions.teamId,
        hasProjectId: !!sandboxOptions.projectId,
        runtime: sandboxOptions.runtime,
        timeout: sandboxOptions.timeout,
      });

      sandbox = await Sandbox.create(sandboxOptions);
    } catch (createError: any) {
      // Enhanced error logging
      const errorDetails: any = {
        errorMessage: createError.message,
        errorName: createError.name,
        statusCode: createError.response?.statusCode,
        body: createError.response?.body,
        headers: createError.response?.headers,
        teamId: VERCEL_TEAM_ID,
        projectId: VERCEL_PROJECT_ID,
        hasToken: !!VERCEL_TOKEN,
      };

      // Try to get raw response
      if (createError.response) {
        try {
          const rawBody = await createError.response.text?.();
          errorDetails.rawBody = rawBody;
        } catch {
          // ignore
        }
      }

      logger.error('Sandbox.create failed - FULL DETAILS', errorDetails);
      throw createError;
    }

    const sandboxId = sandbox.sandboxId;

    // Get preview URLs for each port
    const previewUrls: Record<number, string> = {};

    for (const port of ports) {
      try {
        previewUrls[port] = sandbox.domain(port);
      } catch {
        // Port not exposed, skip
      }
    }

    // Update project with sandbox info (use snake_case for DB columns)
    await updateProject(projectId, session.user.id, {
      sandbox_id: sandboxId,
      sandbox_provider: 'vercel',
      sandbox_expires_at: new Date(Date.now() + timeout),
    });

    logger.info('Sandbox created successfully', { projectId, sandboxId });

    const response: CreateSandboxResponse = {
      sandboxId,
      status: 'running',
      previewUrls,
      timeout,
      createdAt: new Date().toISOString(),
    };

    return json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to create sandbox', { error: message });

    return json(
      {
        error: 'Failed to create sandbox',
        code: 'INTERNAL_ERROR',
        details: message,
      },
      { status: 500 },
    );
  }
}
