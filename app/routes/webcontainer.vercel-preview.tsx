import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { useLoaderData } from '@remix-run/react';

/**
 * Vercel Sandbox Preview Route
 *
 * This route provides a COEP-free environment for embedding Vercel Sandbox previews.
 * The main workbench has strict COEP headers for WebContainer, but Vercel Sandbox
 * URLs don't have compatible CORS headers, causing ERR_BLOCKED_BY_RESPONSE errors.
 *
 * By loading the Vercel Sandbox in this separate route (which has no COEP headers),
 * we can embed it in the main workbench iframe without CORS issues.
 *
 * Health check polling is done in Preview.tsx (main app context) via the
 * /api/sandbox/health endpoint. This route simply renders the sandbox iframe
 * once Preview.tsx has determined the dev server is ready.
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

  return (
    <div className="w-full h-full relative bg-white dark:bg-gray-900">
      <iframe
        title="Vercel Sandbox Preview"
        className="w-full h-full border-none"
        src={sandboxUrl}
        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-storage-access-by-user-activation allow-same-origin"
        loading="eager"
      />
    </div>
  );
}
