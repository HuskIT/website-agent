/**
 * API route for writing files to a Vercel Sandbox
 *
 * POST /api/sandbox/files - Write multiple files to sandbox
 */

import { json, type ActionFunctionArgs } from '@remix-run/node';
import { Sandbox } from '@vercel/sandbox';
import { getSession } from '~/lib/auth/session.server';
import { getProjectById } from '~/lib/services/projects.server';
import { WriteFilesRequestSchema, type WriteFilesResponse } from '~/lib/sandbox/schemas';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.sandbox.files');

/**
 * POST /api/sandbox/files
 *
 * Writes multiple files to a Vercel Sandbox in a single batch operation.
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
    const parseResult = WriteFilesRequestSchema.safeParse(body);

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

    const { projectId, sandboxId, files } = parseResult.data;

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

    // Prepare files for writing (SDK expects Array<{ path: string; content: Buffer }>)
    const filesToWrite: Array<{ path: string; content: Buffer }> = [];

    for (const file of files) {
      const content =
        file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf-8');
      filesToWrite.push({ path: file.path, content });
    }

    // Write files to sandbox
    await sandbox.writeFiles(filesToWrite);

    logger.info('Files written to sandbox', {
      projectId,
      sandboxId,
      fileCount: files.length,
      paths: files.map((f) => f.path),
    });

    const response: WriteFilesResponse = {
      success: true,
      filesWritten: files.length,
    };

    return json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to write files to sandbox', { error: message });

    return json(
      {
        error: 'Failed to write files',
        code: 'INTERNAL_ERROR',
        details: message,
      },
      { status: 500 },
    );
  }
}
