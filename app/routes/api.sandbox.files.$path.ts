/**
 * API route for reading a file from a Vercel Sandbox
 *
 * GET /api/sandbox/files/:path - Read a file from sandbox
 */

import { json, type LoaderFunctionArgs } from '@remix-run/node';
import { Sandbox } from '@vercel/sandbox';
import { getSession } from '~/lib/auth/session.server';
import { getProjectById } from '~/lib/services/projects.server';
import type { ReadFileResponse } from '~/lib/sandbox/schemas';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.sandbox.files.$path');

/**
 * GET /api/sandbox/files/:path
 *
 * Reads a single file from a Vercel Sandbox.
 * Requires authentication and project ownership.
 *
 * Query params:
 * - projectId: UUID of the project
 * - sandboxId: ID of the sandbox
 */
export async function loader({ params, request }: LoaderFunctionArgs) {
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

    // Get path from params (already URL decoded by Remix)
    const filePath = params.path;

    if (!filePath) {
      return json({ error: 'File path is required', code: 'INVALID_INPUT' }, { status: 400 });
    }

    // Get query params
    const url = new URL(request.url);
    const projectId = url.searchParams.get('projectId');
    const sandboxId = url.searchParams.get('sandboxId');

    if (!projectId) {
      return json({ error: 'Project ID is required', code: 'INVALID_INPUT' }, { status: 400 });
    }

    if (!sandboxId) {
      return json({ error: 'Sandbox ID is required', code: 'INVALID_INPUT' }, { status: 400 });
    }

    // Verify project ownership
    const project = await getProjectById(projectId, session.user.id);

    if (!project) {
      return json({ error: 'Project not found', code: 'NOT_FOUND' }, { status: 404 });
    }

    // Verify sandbox belongs to project
    if (project.sandbox_id !== sandboxId) {
      return json({ error: 'Sandbox does not belong to project', code: 'FORBIDDEN' }, { status: 403 });
    }

    // Get sandbox instance
    let sandbox;

    try {
      sandbox = await Sandbox.get({ sandboxId });
    } catch {
      return json({ error: 'Sandbox not found or expired', code: 'SANDBOX_NOT_FOUND' }, { status: 404 });
    }

    if (!sandbox || sandbox.status !== 'running') {
      return json({ error: 'Sandbox not found or not running', code: 'SANDBOX_NOT_FOUND' }, { status: 404 });
    }

    // Read file from sandbox
    try {
      // Normalize path - ensure it starts with /
      const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`;

      // Try reading as buffer first (more reliable for detecting binary)
      const result = await sandbox.readFileToBuffer({ path: normalizedPath });

      if (result === null) {
        const response: ReadFileResponse = {
          content: null,
          encoding: 'utf8',
          exists: false,
        };
        return json(response);
      }

      // Try to decode as UTF-8, if it fails treat as binary
      let content: string;
      let encoding: 'utf8' | 'base64';

      try {
        content = result.toString('utf8');

        // Check for binary content (null bytes indicate binary)
        const isBinary = content.includes('\0');

        if (isBinary) {
          content = result.toString('base64');
          encoding = 'base64';
        } else {
          encoding = 'utf8';
        }
      } catch {
        // Failed to decode as UTF-8, treat as binary
        content = result.toString('base64');
        encoding = 'base64';
      }

      const response: ReadFileResponse = {
        content,
        encoding,
        exists: true,
      };

      return json(response);
    } catch (_error) {
      // File doesn't exist or read error
      const response: ReadFileResponse = {
        content: null,
        encoding: 'utf8',
        exists: false,
      };
      return json(response);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to read file from sandbox', { error: message, path: params.path });

    return json(
      {
        error: 'Failed to read file',
        code: 'INTERNAL_ERROR',
        details: message,
      },
      { status: 500 },
    );
  }
}
