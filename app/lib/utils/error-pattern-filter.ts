/**
 * Smart error pattern filtering to reduce false positives
 *
 * This module provides improved error detection that:
 * 1. Filters out code comments and documentation
 * 2. Ignores error handling code (try/catch)
 * 3. Only detects actual runtime errors
 */

/**
 * Patterns that indicate actual runtime errors (not code)
 * These are more specific than the original patterns
 */
export const RUNTIME_ERROR_PATTERNS = [
  {
    pattern: 'vite-error-overlay',
    context: 'element', // Must be in an HTML element
    description: "Vite's error overlay component",
  },
  {
    pattern: /Uncaught\s+(ReferenceError|TypeError|SyntaxError|Error)/,
    context: 'text',
    description: 'Uncaught JavaScript exceptions',
  },
  {
    pattern: /Failed to (fetch|compile|resolve module)/i,
    context: 'text',
    description: 'Build or module resolution failures',
  },
  {
    pattern: '[plugin:vite:',
    context: 'text',
    description: 'Vite plugin errors',
  },
  {
    pattern: 'Build failed with',
    context: 'text',
    description: 'Explicit build failures',
  },
  {
    pattern: /ENOENT.*no such file/i,
    context: 'text',
    description: 'File not found errors',
  },
  {
    pattern: 'Internal server error occurred',
    context: 'text',
    description: 'Vite server errors',
  },
];

/**
 * Patterns to ignore (false positives)
 * These indicate the error text is part of code, not an actual error
 */
const IGNORE_PATTERNS = [
  /\/\/[^\n]*Error/i, // Single-line comment containing "Error"
  /\/\*[\s\S]*?Error[\s\S]*?\*\//i, // Multi-line comment containing "Error"
  /class\s+\w*Error/i, // Error class definitions
  /catch\s*\(\s*\w*[Ee]rror/i, // catch(error) blocks
  /throw\s+new\s+\w*Error/i, // throw new Error statements
  /console\.(error|warn|log)\(/i, // Console logging statements
  /import.*Error.*from/i, // Import statements
  /export.*Error/i, // Export statements
  /__HUSKIT_CONSOLE_INTERCEPTOR_/i, // Console interceptor code
  /HUSKIT_CONSOLE_INTERCEPTOR_(START|END)/i, // Interceptor markers
];

/**
 * Check if error text is likely a false positive
 * Only checks if the MATCHED TEXT is part of code/comments, not the entire context
 */
function isLikelyFalsePositive(matchedText: string, context: string): boolean {
  /*
   * Special handling for element-based patterns (like vite-error-overlay)
   * These are never false positives as they're HTML elements, not code
   */
  if (matchedText.includes('vite-error-overlay') || matchedText.includes('[plugin:vite')) {
    return false;
  }

  // Extract the line containing the match for more precise checking
  const lines = context.split('\n');
  const matchLine = lines.find((line) => line.includes(matchedText));

  if (!matchLine) {
    return false;
  }

  // Check if the matched text is in a comment on that line
  if (/\/\/.*/.test(matchLine) && matchLine.indexOf('//') < matchLine.indexOf(matchedText)) {
    return true; // Match is after // comment marker
  }

  // Check if it's in a multi-line comment
  if (/\/\*[\s\S]*?\*\//.test(context)) {
    const commentMatch = context.match(/\/\*[\s\S]*?\*\//);

    if (commentMatch && commentMatch[0].includes(matchedText)) {
      return true;
    }
  }

  // Check other ignore patterns
  return IGNORE_PATTERNS.some((pattern) => pattern.test(matchLine));
}

/**
 * Strip console interceptor code from HTML
 * More robust than the original version
 */
export function stripConsoleInterceptor(html: string): string {
  // Method 1: Remove by markers
  let cleaned = html;
  const startMarker = '/* HUSKIT_CONSOLE_INTERCEPTOR_START';
  const endMarker = 'HUSKIT_CONSOLE_INTERCEPTOR_END */';

  const startIdx = cleaned.indexOf(startMarker);
  const endIdx = cleaned.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    cleaned = cleaned.slice(0, startIdx) + cleaned.slice(endIdx + endMarker.length);
  }

  // Method 2: Remove by comment marker (fallback)
  cleaned = cleaned.replace(/<!--\s*HuskIT Console Interceptor[\s\S]*?<\/script>/gi, '');

  // Method 3: Remove by installed flag (additional fallback)
  cleaned = cleaned.replace(/<script>[\s\S]*?__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__[\s\S]*?<\/script>/gi, '');

  return cleaned;
}

/**
 * Detect if HTML contains actual runtime errors (not code)
 *
 * Returns error info if found, null otherwise
 */
export function detectRuntimeError(html: string): {
  pattern: string;
  snippet: string;
  description: string;
} | null {
  // Strip interceptor code first to avoid false positives
  const cleaned = stripConsoleInterceptor(html);

  // Check each error pattern
  for (const errorDef of RUNTIME_ERROR_PATTERNS) {
    const { pattern, description } = errorDef;

    let matchIndex = -1;
    let matchedText = '';

    if (typeof pattern === 'string') {
      matchIndex = cleaned.indexOf(pattern);
      matchedText = pattern;
    } else if (pattern instanceof RegExp) {
      const match = cleaned.match(pattern);

      if (match) {
        matchIndex = match.index ?? -1;
        matchedText = match[0];
      }
    }

    if (matchIndex === -1) {
      continue;
    }

    // Extract context around the match
    const contextStart = Math.max(0, matchIndex - 200);
    const contextEnd = Math.min(cleaned.length, matchIndex + 200);
    const context = cleaned.slice(contextStart, contextEnd);

    // Check if it's a false positive
    if (isLikelyFalsePositive(matchedText, context)) {
      continue;
    }

    // Extract a readable snippet
    const snippetStart = Math.max(0, matchIndex - 100);
    const snippetEnd = Math.min(cleaned.length, matchIndex + 400);
    let snippet = cleaned.slice(snippetStart, snippetEnd).trim();

    if (snippet.length > 500) {
      snippet = snippet.slice(0, 500) + '...';
    }

    return {
      pattern: matchedText,
      snippet,
      description,
    };
  }

  return null;
}

/**
 * Check if error is real or a false positive
 * Used by Preview component to filter console messages
 */
export function isRealError(message: string): boolean {
  // Common false positive patterns in console messages
  const falsePositives = [
    /^\[.*\]\s*(log|info|debug)/i, // Debug logs
    /^Download.*complete/i, // Download notifications
    /^DevTools/i, // DevTools messages
    /^webpack/i, // Webpack info (not errors)
    /\[HMR\]/i, // Hot module reload info (anywhere in message)
    /^HMR\s/i, // HMR at start
  ];

  return !falsePositives.some((pattern) => pattern.test(message));
}
