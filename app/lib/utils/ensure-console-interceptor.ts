/**
 * Utility to ensure console interceptor is present in HTML files
 *
 * This handles cases where the interceptor might be missing:
 * - LLM edits overwrite index.html
 * - Sandbox restored from Vercel snapshot (no file upload)
 * - Manual user edits
 */

import { injectConsoleInterceptor, hasConsoleInterceptor } from './inject-console-interceptor';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ConsoleInterceptorGuard');

/**
 * Ensure console interceptor is present in content if it's an HTML file
 *
 * @param filePath - File path to check
 * @param content - File content
 * @returns Content with interceptor (if applicable) or original content
 */
export function ensureConsoleInterceptor(filePath: string, content: string): string {
  // Only process HTML files
  if (!filePath.match(/\.(html|htm)$/i)) {
    return content;
  }

  // Only process if it looks like HTML
  if (!content.includes('<html')) {
    return content;
  }

  // Check if interceptor already present
  if (hasConsoleInterceptor(content)) {
    return content;
  }

  // Inject interceptor
  logger.info('Console interceptor missing, injecting into:', filePath);

  return injectConsoleInterceptor(content);
}

/**
 * Ensure console interceptor in multiple files (batch operation)
 *
 * Modifies files in place
 */
export function ensureConsoleInterceptorBatch(files: Record<string, { content: string; isBinary?: boolean }>): void {
  const htmlFiles = ['index.html', 'index.htm', '404.html'];

  for (const fileName of htmlFiles) {
    const file = files[fileName];

    if (file && !file.isBinary && typeof file.content === 'string') {
      const newContent = ensureConsoleInterceptor(fileName, file.content);

      if (newContent !== file.content) {
        file.content = newContent;
        logger.info('Console interceptor injected into:', fileName);
      }
    }
  }
}
