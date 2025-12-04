import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { createClient } from '@supabase/supabase-js';

function getSupabaseClient(env?: any) {
  const supabaseUrl = env?.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL; // ✅ CORRECT
  const supabaseKey = env?.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase credentials');
  }

  return createClient(supabaseUrl, supabaseKey);
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const authHeader = request.headers.get('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return Response.json(
        {
          authenticated: false,
          user: null,
        },
        { status: 401 },
      );
    }

    const token = authHeader.replace('Bearer ', '');

    const supabase = getSupabaseClient(context?.env);

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      console.error('Session check error:', error);
      return Response.json(
        {
          authenticated: false,
          user: null,
        },
        { status: 401 },
      );
    }

    return Response.json({
      authenticated: true,
      user: {
        id: data.user.id,
        email: data.user.email!,
        name: data.user.user_metadata?.full_name || data.user.email!.split('@')[0],
        avatar: data.user.user_metadata?.avatar_url,
      },
      token,
    });
  } catch (error) {
    console.error('Session check error:', error);
    return Response.json(
      {
        error: 'Internal server error',
        authenticated: false,
        user: null,
      },
      { status: 500 },
    );
  }
}
