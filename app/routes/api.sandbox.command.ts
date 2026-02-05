/**
 * API route for executing commands in a Vercel Sandbox with SSE streaming
 *
 * POST /api/sandbox/command - Execute a command with streaming output
 */

import { type ActionFunctionArgs } from '@remix-run/node';
import { Sandbox } from '@vercel/sandbox';
import { getSession } from '~/lib/auth/session.server';
import { getProjectById } from '~/lib/services/projects.server';
import { RunCommandRequestSchema, type CommandSSEEvent } from '~/lib/sandbox/schemas';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.sandbox.command');

/**
 * POST /api/sandbox/command
 *
 * Executes a command in a Vercel Sandbox with SSE streaming output.
 * Requires authentication and project ownership.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Check if Vercel Sandbox is enabled
  if (process.env.SANDBOX_VERCEL_ENABLED === 'false') {
    return new Response(JSON.stringify({ error: 'Vercel Sandbox is disabled', code: 'FEATURE_DISABLED' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check method
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Authenticate
    const session = await getSession(request);

    if (!session?.user) {
      return new Response(JSON.stringify({ error: 'Authentication required', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Parse and validate request body
    const body = await request.json();
    const parseResult = RunCommandRequestSchema.safeParse(body);

    if (!parseResult.success) {
      return new Response(
        JSON.stringify({
          error: 'Invalid request body',
          code: 'INVALID_INPUT',
          details: parseResult.error.issues,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    const { projectId, sandboxId, cmd, args, cwd, env, timeout, sudo } = parseResult.data;

    // Verify project ownership
    const project = await getProjectById(projectId, session.user.id);

    if (!project) {
      return new Response(JSON.stringify({ error: 'Project not found', code: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Verify sandbox belongs to project
    if (project.sandbox_id !== sandboxId) {
      return new Response(JSON.stringify({ error: 'Sandbox does not belong to project', code: 'FORBIDDEN' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get sandbox instance
    let sandbox;

    try {
      sandbox = await Sandbox.get({ sandboxId });
    } catch {
      return new Response(JSON.stringify({ error: 'Sandbox not found or expired', code: 'SANDBOX_NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!sandbox || sandbox.status !== 'running') {
      return new Response(JSON.stringify({ error: 'Sandbox not found or not running', code: 'SANDBOX_NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    logger.info('Executing command in sandbox', {
      projectId,
      sandboxId,
      cmd,
      args,
      cwd,
    });

    // Create SSE stream
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const sendEvent = (event: CommandSSEEvent) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        try {
          // Create abort controller for timeout
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), timeout || 30000);

          // Execute command
          const execution = await sandbox.runCommand({
            cmd,
            args: args || [],
            cwd,
            env,
            sudo,
            signal: abortController.signal,
          });

          clearTimeout(timeoutId);

          // Get stdout and stderr (these are async methods)
          const stdoutContent = await execution.stdout();
          const stderrContent = await execution.stderr();

          // Stream stdout
          if (stdoutContent) {
            sendEvent({
              type: 'output',
              stream: 'stdout',
              data: stdoutContent,
            });
          }

          // Stream stderr
          if (stderrContent) {
            sendEvent({
              type: 'output',
              stream: 'stderr',
              data: stderrContent,
            });
          }

          // Send exit event
          sendEvent({
            type: 'exit',
            exitCode: execution.exitCode,
          });

          // Send done marker
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('Command execution failed', { error: message, cmd, sandboxId });

          sendEvent({
            type: 'error',
            message,
          });

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to execute command', { error: message });

    return new Response(
      JSON.stringify({
        error: 'Failed to execute command',
        code: 'INTERNAL_ERROR',
        details: message,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}
