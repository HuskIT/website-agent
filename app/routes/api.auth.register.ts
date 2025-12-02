import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { createClient } from '@supabase/supabase-js';
import { verifyCsrfToken, getCsrfTokenFromCookies } from '~/utils/csrf';
import { isValidEmail, isStrongPassword, isValidName, sanitizeInput } from '~/utils/validation';

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
      console.warn('CSRF validation failed for register request');
      return Response.json({ error: 'Invalid CSRF token. Please refresh and try again.' }, { status: 403 });
    }

    // ✅ Parse và validate request body
    let body: any;

    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      typeof body.email !== 'string' ||
      typeof body.password !== 'string'
    ) {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const email = sanitizeInput(body.email, 254);
    const password = body.password;
    const name = body.name ? sanitizeInput(body.name, 100) : undefined;

    // ✅ IMPROVED: Proper email validation
    if (!isValidEmail(email)) {
      return Response.json({ error: 'Email không hợp lệ' }, { status: 400 });
    }

    // ✅ IMPROVED: Strong password validation
    const passwordCheck = isStrongPassword(password);

    if (!passwordCheck.valid) {
      return Response.json(
        {
          error: 'Mật khẩu không đủ mạnh',
          details: passwordCheck.errors,
        },
        { status: 400 },
      );
    }

    // ✅ Validate name if provided
    if (name && !isValidName(name)) {
      return Response.json({ error: 'Tên không hợp lệ (1-100 ký tự, chỉ chữ cái và số)' }, { status: 400 });
    }

    const supabase = getSupabaseClient(context?.env);

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name,
        },
      },
    });

    if (error) {
      console.error('Supabase register error:', error);

      // ✅ Better error messages
      const errorMessages: Record<string, string> = {
        'User already registered': 'Email đã được đăng ký',
        'Password should be at least 6 characters': 'Mật khẩu phải có ít nhất 6 ký tự',
        'Unable to validate email address: invalid format': 'Email không hợp lệ',
        'Signup requires a valid password': 'Mật khẩu không hợp lệ',
      };

      return Response.json(
        {
          error: errorMessages[error.message] || error.message,
        },
        { status: 400 },
      );
    }

    if (!data.user) {
      return Response.json({ error: 'Đăng ký thất bại' }, { status: 400 });
    }

    const needsConfirmation = !data.session;

    return Response.json({
      success: true,
      needsConfirmation,
      message: needsConfirmation ? 'Vui lòng kiểm tra email để xác nhận tài khoản' : 'Đăng ký thành công',
      user: {
        id: data.user.id,
        email: data.user.email!,
      },
    });
  } catch (error) {
    console.error('Register API error:', error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}
