import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { createClient } from '@supabase/supabase-js';
import { verifyCsrfToken, getCsrfTokenFromCookies } from '~/utils/csrf';

function getSupabaseClient(env?: any) {
  const supabaseUrl = env?.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = env?.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase credentials');
  }

  return createClient(supabaseUrl, supabaseKey);
}

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    // ✅ CSRF Protection
    const csrfToken = getCsrfTokenFromCookies(request);

    if (!verifyCsrfToken(request, csrfToken)) {
      console.warn('CSRF validation failed for logout request');
      return Response.json({ error: 'Invalid CSRF token. Please refresh and try again.' }, { status: 403 });
    }

    const authHeader = request.headers.get('Authorization');

    // If no token, user is already logged out
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return Response.json({
        success: true,
        message: 'Already logged out',
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const supabase = getSupabaseClient(context?.env);

    // Verify token before logout
    const { data: userData, error: userError } = await supabase.auth.getUser(token);

    // If token is invalid, still return success
    if (userError || !userData.user) {
      return Response.json({
        success: true,
        message: 'Already logged out',
      });
    }

    // Sign out from Supabase
    const { error: signOutError } = await supabase.auth.signOut();

    if (signOutError) {
      console.error('Supabase logout error:', signOutError);

      // Still return success so client can clear local storage
    }

    return Response.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    console.error('Logout API error:', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
