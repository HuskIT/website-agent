/**
 * Utility to inject console interceptor into HTML files
 *
 * This can be applied to:
 * - Generated websites during file sync
 * - Template files before saving
 * - Any HTML content that needs console capture
 */

import { getConsoleInterceptorCode } from '~/lib/runtime/console-interceptor';

/**
 * Inject console interceptor script into HTML content
 *
 * Strategies (in order of preference):
 * 1. Before </head> - Best for early capture
 * 2. After <head> - If no closing head tag
 * 3. Before </body> - Fallback
 * 4. At start of HTML - Last resort
 *
 * @param html - HTML content to inject into
 * @returns Modified HTML with console interceptor
 */
export function injectConsoleInterceptor(html: string): string {
  // Skip if already injected
  if (html.includes('__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__')) {
    return html;
  }

  const script = `
<!-- HuskIT Console Interceptor - Auto-injected -->
<script>
${getConsoleInterceptorCode()}
</script>
`;

  // Strategy 1: Before </head> (preferred)
  if (html.includes('</head>')) {
    return html.replace('</head>', `${script}\n</head>`);
  }

  // Strategy 2: After <head>
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>\n${script}`);
  }

  // Strategy 3: Before </body>
  if (html.includes('</body>')) {
    return html.replace('</body>', `${script}\n</body>`);
  }

  // Strategy 4: At start (last resort)
  return script + '\n' + html;
}

/**
 * Check if HTML already has console interceptor
 */
export function hasConsoleInterceptor(html: string): boolean {
  return html.includes('__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__');
}

/**
 * Remove console interceptor from HTML (for cleanup/testing)
 */
export function removeConsoleInterceptor(html: string): string {
  // Remove the entire script block
  const regex = /<!--\s*HuskIT Console Interceptor[\s\S]*?<\/script>/g;
  return html.replace(regex, '');
}

/**
 * Inject into multiple files (batch operation)
 *
 * @param files - File map (path -> content)
 * @returns Modified file map with interceptor injected into HTML files
 */
export function injectConsoleInterceptorBatch(files: Record<string, { content: string; isBinary?: boolean }>): void {
  const htmlFiles = ['index.html', 'index.htm', '404.html'];

  for (const fileName of htmlFiles) {
    const file = files[fileName];

    if (file && !file.isBinary && typeof file.content === 'string') {
      // Check if it's HTML content
      if (file.content.includes('<html') || file.content.includes('<!DOCTYPE')) {
        file.content = injectConsoleInterceptor(file.content);
      }
    }
  }
}
