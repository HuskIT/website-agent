import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { generateCsrfToken, createCsrfCookie } from '~/utils/csrf';

/**
 * GET /api/auth/csrf
 * Returns a CSRF token and sets it as an httpOnly cookie
 */
export async function loader(_: LoaderFunctionArgs) {
  try {
    const token = generateCsrfToken();

    return Response.json(
      {
        token,
        success: true,
      },
      {
        headers: {
          'Set-Cookie': createCsrfCookie(token),
        },
      },
    );
  } catch (error) {
    console.error('CSRF token generation error:', error);
    return Response.json({ error: 'Failed to generate CSRF token' }, { status: 500 });
  }
}
