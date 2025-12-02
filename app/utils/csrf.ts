/**
 * CSRF Protection utilities
 */

const CSRF_TOKEN_LENGTH = 32;
const CSRF_TOKEN_COOKIE = 'csrf_token';

/**
 * Generate a CSRF token
 */
export function generateCsrfToken(): string {
  // Generate random bytes for CSRF token
  const array = new Uint8Array(CSRF_TOKEN_LENGTH);
  crypto.getRandomValues(array);

  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify CSRF token from request
 */
export function verifyCsrfToken(request: Request, cookieToken: string | null): boolean {
  // Get token from header
  const headerToken = request.headers.get('X-CSRF-Token');

  if (!headerToken || !cookieToken) {
    console.warn('CSRF validation failed: missing token', {
      hasHeader: !!headerToken,
      hasCookie: !!cookieToken,
    });
    return false;
  }

  // Timing-safe comparison to prevent timing attacks
  return timingSafeEqual(headerToken, cookieToken);
}

/**
 * Timing-safe string comparison
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

/**
 * Parse cookies from request
 */
export function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get('Cookie');

  if (!cookieHeader) {
    return {};
  }

  return Object.fromEntries(
    cookieHeader.split(';').map((cookie) => {
      const [key, ...rest] = cookie.trim().split('=');
      return [key, rest.join('=')];
    }),
  );
}

/**
 * Create CSRF cookie
 */
export function createCsrfCookie(token: string): string {
  // Cookie expires in 24 hours
  const maxAge = 60 * 60 * 24;
  return `${CSRF_TOKEN_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

/**
 * Get CSRF token from cookies
 */
export function getCsrfTokenFromCookies(request: Request): string | null {
  const cookies = parseCookies(request);
  return cookies[CSRF_TOKEN_COOKIE] || null;
}
