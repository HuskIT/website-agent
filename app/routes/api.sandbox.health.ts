/**
 * API route for checking if a Vercel Sandbox dev server is ready
 *
 * POST /api/sandbox/health - Server-side health check
 *
 * Fetches the sandbox URL from the server side (no CORS restrictions)
 * and inspects the response body to determine if the actual dev server
 * (Vite/Next.js) is running, not just the Vercel proxy returning its
 * own loading/error page.
 */

import { json, type ActionFunctionArgs } from '@remix-run/node';

/**
 * Patterns in the response body that indicate the dev server is NOT ready.
 * The Vercel proxy returns its own page with these when the internal server
 * hasn't started yet.
 */
const NOT_READY_PATTERNS = [
  'localhost refused to connect',
  'refused to connect',
  'bad gateway',
  '502 bad gateway',
  '503 service unavailable',
  'could not connect',
  'connection refused',
  'is not running',
  'starting up',
  'please wait',
  'loading...',
  'initializing',
];

/**
 * Patterns that indicate a real dev server response (Vite, Next.js, etc.)
 * These are framework-specific markers that only appear in actual app pages,
 * not in the Vercel proxy's error or loading pages.
 */
const READY_PATTERNS = [
  '/@vite/client', // Vite HMR client injection
  'type="module"', // ES module scripts (Vite uses these)
  '__vite_ssr', // Vite SSR markers
  '__next', // Next.js markers
  'src="/src/', // Vite app entry point
  '<div id="root"', // React mount point
  '<div id="app"', // Vue mount point
  '<div id="__next"', // Next.js mount point
];

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ ready: false }, { status: 405 });
  }

  try {
    const body = (await request.json()) as { url?: string };
    const url = body?.url;

    if (!url || !url.includes('vercel.run')) {
      return json({ ready: false });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html' },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return json({ ready: false, status: response.status });
    }

    const text = await response.text();
    const lowerText = text.toLowerCase();

    // Check for NOT-ready patterns (proxy error/loading pages)
    const hasNotReadyPattern = NOT_READY_PATTERNS.some((pattern) => lowerText.includes(pattern));

    if (hasNotReadyPattern) {
      return json({ ready: false, reason: 'proxy-error-page' });
    }

    // Check for positive dev server indicators
    const hasReadyPattern = READY_PATTERNS.some((pattern) => lowerText.includes(pattern));

    /*
     * If the response contains framework-specific markers (/@vite/client,
     * <div id="root">, etc.) and no error patterns, the dev server is ready.
     * The Vite index.html is typically ~585 bytes — small but contains
     * distinctive markers that the Vercel proxy error page does not.
     */
    const isReady = hasReadyPattern;

    return json({ ready: isReady, bodyLength: text.length, hasAppMarkers: hasReadyPattern });
  } catch {
    return json({ ready: false });
  }
}
