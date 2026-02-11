/**
 * Portable Console Interceptor for HuskIT Website Agent
 *
 * This script captures console output from generated websites and sends it
 * to the parent window via postMessage on a dedicated channel.
 *
 * Features:
 * - Captures console.log, error, warn, info
 * - Captures uncaught errors and unhandled rejections
 * - Uses dedicated channel 'huskit:preview-console' (no platform conflicts)
 * - Preserves original console behavior
 * - Can be embedded in templates or injected dynamically
 * - Minimal overhead, non-blocking
 *
 * Usage:
 * 1. Embed in template: Add <script src="...console-interceptor.js"></script>
 * 2. Inject dynamically: Insert before </head> tag during file sync
 * 3. Inline: Wrap in <script>{CONSOLE_INTERCEPTOR_CODE}</script>
 */

/**
 * Generate the console interceptor code as a string (for injection)
 */
export function getConsoleInterceptorCode(): string {
  return `
(function() {
  'use strict';

  // Skip if already installed
  if (window.__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__) {
    return;
  }
  window.__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__ = true;

  // Configuration
  const CONFIG = {
    channel: 'huskit:preview-console',  // Dedicated channel (no platform conflicts)
    maxMessageLength: 5000,              // Truncate long messages
    throttleMs: 50,                      // Throttle rapid-fire logs
    sendErrors: true,                    // Auto-send errors immediately
    sendWarnings: false,                 // Don't auto-send warnings (too noisy)
  };

  // Store original console methods
  const originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
  };

  // Throttle helper
  let lastSendTime = 0;
  function shouldThrottle() {
    const now = Date.now();
    if (now - lastSendTime < CONFIG.throttleMs) {
      return true;
    }
    lastSendTime = now;
    return false;
  }

  // Send message to parent window
  function sendToParent(level, args, isAutoError = false) {
    if (shouldThrottle() && !isAutoError) {
      return; // Skip throttled messages (but never throttle auto-errors)
    }

    try {
      // Serialize arguments
      const message = args.map(arg => {
        if (arg instanceof Error) {
          return \`\${arg.name}: \${arg.message}\\n\${arg.stack || ''}\`;
        }
        if (typeof arg === 'object' && arg !== null) {
          try {
            return JSON.stringify(arg, null, 2);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      }).join(' ');

      // Truncate if too long
      const truncated = message.length > CONFIG.maxMessageLength
        ? message.slice(0, CONFIG.maxMessageLength) + '... (truncated)'
        : message;

      // Build payload
      const payload = {
        type: CONFIG.channel,
        level: level,
        message: truncated,
        timestamp: Date.now(),
        url: window.location.href,
        userAgent: navigator.userAgent,
        autoError: isAutoError, // Flag for immediate LLM sending
      };

      // Send via postMessage (works cross-origin)
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, '*');
      }
    } catch (err) {
      // Silently fail - don't break the app
      originalConsole.error('[HuskIT Console Interceptor] Failed to send message:', err);
    }
  }

  // Override console.log
  console.log = function(...args) {
    originalConsole.log.apply(console, args);
    sendToParent('log', args);
  };

  // Override console.error
  console.error = function(...args) {
    originalConsole.error.apply(console, args);
    sendToParent('error', args, CONFIG.sendErrors);
  };

  // Override console.warn
  console.warn = function(...args) {
    originalConsole.warn.apply(console, args);
    sendToParent('warn', args, CONFIG.sendWarnings);
  };

  // Override console.info
  console.info = function(...args) {
    originalConsole.info.apply(console, args);
    sendToParent('info', args);
  };

  // Capture uncaught errors
  window.addEventListener('error', function(event) {
    const errorMsg = [
      \`Uncaught \${event.error?.name || 'Error'}: \${event.message}\`,
      event.filename ? \`at \${event.filename}:\${event.lineno}:\${event.colno}\` : '',
      event.error?.stack || ''
    ].filter(Boolean).join('\\n');

    sendToParent('error', [errorMsg], true); // Auto-send to LLM
  });

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', function(event) {
    const reason = event.reason instanceof Error
      ? \`\${event.reason.name}: \${event.reason.message}\\n\${event.reason.stack || ''}\`
      : String(event.reason);

    sendToParent('error', [\`Unhandled Promise Rejection: \${reason}\`], true); // Auto-send to LLM
  });

  // Silent installation confirmation (only in parent console, not in iframe)
  if (window.parent && window.parent !== window) {
    sendToParent('info', ['🔧 HuskIT Console Interceptor installed']);
  }
})();
`.trim();
}

/**
 * Generate inline script tag with console interceptor
 */
export function getConsoleInterceptorScriptTag(): string {
  return `<script>
${getConsoleInterceptorCode()}
</script>`;
}

/**
 * Message type for console logs from preview
 */
export interface PreviewConsoleMessage {
  type: 'huskit:preview-console';
  level: 'log' | 'error' | 'warn' | 'info';
  message: string;
  timestamp: number;
  url: string;
  userAgent: string;
  autoError: boolean; // If true, should auto-send to LLM
}

/**
 * Type guard for preview console messages
 */
export function isPreviewConsoleMessage(data: unknown): data is PreviewConsoleMessage {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const msg = data as Partial<PreviewConsoleMessage>;

  return (
    msg.type === 'huskit:preview-console' &&
    typeof msg.level === 'string' &&
    typeof msg.message === 'string' &&
    typeof msg.timestamp === 'number' &&
    typeof msg.url === 'string'
  );
}
