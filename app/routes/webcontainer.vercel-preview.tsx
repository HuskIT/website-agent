import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { useLoaderData } from '@remix-run/react';
import { useEffect, useRef, useState } from 'react';

/**
 * Vercel Sandbox Preview Route
 *
 * This route provides a COEP-free environment for embedding Vercel Sandbox previews.
 * The main workbench has strict COEP headers for WebContainer, but Vercel Sandbox
 * URLs don't have compatible CORS headers, causing ERR_BLOCKED_BY_RESPONSE errors.
 *
 * By loading the Vercel Sandbox in this separate route (which has no COEP headers),
 * we can embed it in the main workbench iframe without CORS issues.
 */

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const sandboxUrl = url.searchParams.get('url');

  if (!sandboxUrl) {
    throw new Response('Sandbox URL is required', { status: 400 });
  }

  // Validate that it's a Vercel Sandbox URL
  if (!sandboxUrl.includes('vercel.run')) {
    throw new Response('Invalid sandbox URL', { status: 400 });
  }

  return json({ sandboxUrl });
}

export default function VercelSandboxPreview() {
  const { sandboxUrl } = useLoaderData<typeof loader>();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPolling, setIsPolling] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollingAttempts, setPollingAttempts] = useState(0);

  // Poll the Vercel Sandbox URL until it's ready
  useEffect(() => {
    if (!isPolling) {
      return undefined;
    }

    let cancelled = false;
    const MAX_ATTEMPTS = 90; // 3 minutes at 2s intervals

    async function pollServer() {
      if (cancelled || pollingAttempts >= MAX_ATTEMPTS) {
        if (!cancelled && pollingAttempts >= MAX_ATTEMPTS) {
          setError('Dev server took too long to start. It may have failed.');
          setIsPolling(false);
          setIsLoading(false);
        }

        return;
      }

      try {
        // Try to fetch the sandbox URL to check if it's ready
        await fetch(sandboxUrl, {
          mode: 'no-cors', // Bypass CORS - we just want to check if it responds
          signal: AbortSignal.timeout(5000),
        });

        // If fetch succeeds, server is ready - load the iframe
        if (!cancelled) {
          console.log('[VercelPreview] Server is ready, loading iframe');
          setIsPolling(false);

          if (iframeRef.current) {
            iframeRef.current.src = sandboxUrl;
          }
        }
      } catch (_ignored) {
        // Server not ready yet, retry after 2 seconds
        if (!cancelled) {
          setPollingAttempts((prev) => prev + 1);
          setTimeout(pollServer, 2000);
        }
      }
    }

    console.log('[VercelPreview] Starting to poll server:', sandboxUrl);
    pollServer();

    return () => {
      cancelled = true;
    };
  }, [sandboxUrl, isPolling, pollingAttempts]);

  const handleLoad = () => {
    setIsLoading(false);
    setError(null);
  };

  const handleError = () => {
    setIsLoading(false);
    setError('Failed to load preview. The sandbox may not be ready yet.');
  };

  return (
    <div className="w-full h-full relative bg-white dark:bg-gray-900">
      {isLoading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-white dark:bg-gray-900 z-10">
          <div className="w-8 h-8 border-2 border-gray-300 border-t-blue-600 rounded-full animate-spin" />
          <div className="mt-4 text-gray-600 dark:text-gray-400 text-sm font-medium">
            {isPolling ? 'Waiting for dev server to start...' : 'Loading preview...'}
          </div>
          {isPolling && pollingAttempts > 0 && (
            <div className="mt-2 text-gray-500 dark:text-gray-500 text-xs">
              Attempt {pollingAttempts} / 90 (this may take 1-2 minutes)
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-white dark:bg-gray-900 z-10">
          <div className="text-red-600 dark:text-red-400 text-sm text-center px-4">{error}</div>
          <button
            onClick={() => {
              setError(null);
              setIsLoading(true);
              setIsPolling(true);
              setPollingAttempts(0);
            }}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      <iframe
        ref={iframeRef}
        title="Vercel Sandbox Preview"
        className="w-full h-full border-none"
        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-storage-access-by-user-activation allow-same-origin"
        loading="eager"
        onLoad={handleLoad}
        onError={handleError}
      />
    </div>
  );
}
