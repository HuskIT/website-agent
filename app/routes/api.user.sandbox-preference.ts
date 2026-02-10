/**
 * API route for user sandbox provider preference
 * Feature: 001-sandbox-providers
 *
 * PATCH /api/user/sandbox-preference - Update preferred sandbox provider
 */

import { json, type ActionFunctionArgs } from '@remix-run/node';
import { getSession } from '~/lib/auth/session.server';
import { createUserSupabaseClient } from '~/lib/db/supabase.server';
import { createScopedLogger } from '~/utils/logger';
import { UpdateSandboxPreferenceRequestSchema, type UpdateSandboxPreferenceResponse } from '~/lib/sandbox/schemas';

const logger = createScopedLogger('api.user.sandbox-preference');

/**
 * PATCH /api/user/sandbox-preference
 *
 * Updates the user's preferred sandbox provider.
 * Requires authentication.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Check method
  if (request.method !== 'PATCH') {
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
    const parseResult = UpdateSandboxPreferenceRequestSchema.safeParse(body);

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

    const { preferredProvider } = parseResult.data;

    // Update user preference in database
    const supabase = await createUserSupabaseClient(session.user.id);

    const { error } = await supabase
      .from('users')
      .update({
        preferred_sandbox_provider: preferredProvider,
        updated_at: new Date().toISOString(),
      })
      .eq('id', session.user.id);

    if (error) {
      logger.error('Failed to update sandbox preference', {
        userId: session.user.id,
        error,
      });

      return json(
        {
          error: 'Failed to update preference',
          code: 'UPDATE_FAILED',
        },
        { status: 500 },
      );
    }

    logger.info('Sandbox preference updated', {
      userId: session.user.id,
      preferredProvider,
    });

    const response: UpdateSandboxPreferenceResponse = {
      success: true,
      preferredProvider,
    };

    return json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to update sandbox preference', { error: message });

    return json(
      {
        error: 'Failed to update preference',
        code: 'INTERNAL_ERROR',
        details: message,
      },
      { status: 500 },
    );
  }
}
