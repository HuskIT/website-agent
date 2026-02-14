import { describe, it, expect } from 'vitest';
import { detectRuntimeError, stripConsoleInterceptor, isRealError } from '~/lib/utils/error-pattern-filter';

describe('error-pattern-filter', () => {
  describe('stripConsoleInterceptor', () => {
    it('should remove console interceptor by markers', () => {
      const html = `<html>
<head>
<script>
/* HUSKIT_CONSOLE_INTERCEPTOR_START */
(function() {
  console.log('Uncaught Error'); // This should be stripped
})();
/* HUSKIT_CONSOLE_INTERCEPTOR_END */
</script>
</head>
<body></body>
</html>`;

      const cleaned = stripConsoleInterceptor(html);

      expect(cleaned).not.toContain('HUSKIT_CONSOLE_INTERCEPTOR_START');
      expect(cleaned).not.toContain('HUSKIT_CONSOLE_INTERCEPTOR_END');
      expect(cleaned).not.toContain('console.log');
    });

    it('should remove console interceptor by HTML comment', () => {
      const html = `<html>
<head>
<!-- HuskIT Console Interceptor - Auto-injected -->
<script>
window.__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__ = true;
</script>
</head>
</html>`;

      const cleaned = stripConsoleInterceptor(html);

      expect(cleaned).not.toContain('HuskIT Console Interceptor');
      expect(cleaned).not.toContain('__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__');
    });

    it('should remove console interceptor by installed flag', () => {
      const html = `<html>
<head>
<script>
window.__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__ = true;
console.error('test');
</script>
</head>
</html>`;

      const cleaned = stripConsoleInterceptor(html);

      expect(cleaned).not.toContain('__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__');
    });

    it('should handle HTML without interceptor', () => {
      const html = '<html><head></head><body></body></html>';
      const cleaned = stripConsoleInterceptor(html);

      expect(cleaned).toBe(html);
    });

    it('should preserve other content when removing interceptor', () => {
      const html = `<html>
<head>
  <title>Test Page</title>
  <!-- HuskIT Console Interceptor - Auto-injected -->
  <script>window.__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__ = true;</script>
  <style>body { margin: 0; }</style>
</head>
<body>
  <h1>Content</h1>
</body>
</html>`;

      const cleaned = stripConsoleInterceptor(html);

      expect(cleaned).toContain('<title>Test Page</title>');
      expect(cleaned).toContain('body { margin: 0; }');
      expect(cleaned).toContain('<h1>Content</h1>');
      expect(cleaned).not.toContain('__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__');
    });
  });

  describe('detectRuntimeError', () => {
    describe('Real errors (should detect)', () => {
      it('should detect vite-error-overlay', () => {
        const html = `<html>
<body>
  <vite-error-overlay class="error-overlay">
    <div>Build failed</div>
  </vite-error-overlay>
</body>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        expect(result?.pattern).toContain('vite-error-overlay');
      });

      it('should detect Uncaught ReferenceError', () => {
        const html = `<html>
<body>
  <div>Uncaught ReferenceError: foo is not defined</div>
</body>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        expect(result?.pattern).toMatch(/Uncaught.*ReferenceError/);
        expect(result?.description).toBe('Uncaught JavaScript exceptions');
      });

      it('should detect Uncaught TypeError', () => {
        const html = `<html><body>Uncaught TypeError: Cannot read property 'x' of undefined</body></html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        expect(result?.pattern).toMatch(/Uncaught.*TypeError/);
      });

      it('should detect Uncaught SyntaxError', () => {
        const html = `<html><body>Uncaught SyntaxError: Unexpected token }</body></html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        expect(result?.pattern).toMatch(/Uncaught.*SyntaxError/);
      });

      it('should detect Failed to fetch', () => {
        const html = `<html><body><p>Failed to fetch data from API</p></body></html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        expect(result?.pattern).toMatch(/Failed to.*fetch/i);
      });

      it('should detect Failed to compile', () => {
        const html = `<html><body>Failed to compile ./src/App.tsx</body></html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        expect(result?.pattern).toMatch(/Failed to compile/i);
      });

      it('should detect Vite plugin errors', () => {
        const html = `<html><body>[plugin:vite:css] Error processing CSS</body></html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        expect(result?.pattern).toBe('[plugin:vite:');
      });

      it('should detect build failures', () => {
        const html = `<html><body>Build failed with 3 errors</body></html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        expect(result?.pattern).toBe('Build failed with');
      });

      it('should detect ENOENT errors', () => {
        const html = `<html><body>ENOENT: no such file or directory '/path/to/file.js'</body></html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        expect(result?.pattern).toMatch(/ENOENT.*no such file/i);
      });

      it('should detect internal server errors', () => {
        const html = `<html><body>Internal server error occurred while processing request</body></html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        expect(result?.pattern).toBe('Internal server error occurred');
      });
    });

    describe('False positives (should NOT detect)', () => {
      it('should ignore comments containing Error', () => {
        const html = `<html>
<head>
<script>
// This is an Error comment
function foo() {
  return 42;
}
</script>
</head>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).toBeNull();
      });

      it('should ignore multi-line comments containing Error', () => {
        const html = `<html>
<head>
<script>
/*
 * Error handling logic below
 * This handles TypeErrors and ReferenceErrors
 */
function handleError() {}
</script>
</head>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).toBeNull();
      });

      it('should ignore Error class definitions', () => {
        const html = `<html>
<head>
<script>
class CustomError extends Error {
  constructor(message) {
    super(message);
  }
}
</script>
</head>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).toBeNull();
      });

      it('should ignore catch(error) blocks', () => {
        const html = `<html>
<head>
<script>
try {
  somethingRisky();
} catch (error) {
  console.error(error);
}
</script>
</head>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).toBeNull();
      });

      it('should ignore throw new Error statements', () => {
        const html = `<html>
<head>
<script>
function validate(input) {
  if (!input) {
    throw new Error('Input is required');
  }
}
</script>
</head>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).toBeNull();
      });

      it('should ignore console.error calls', () => {
        const html = `<html>
<head>
<script>
console.error('Something went wrong');
console.warn('TypeError occurred');
console.log('ReferenceError in logs');
</script>
</head>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).toBeNull();
      });

      it('should ignore import/export statements', () => {
        const html = `<html>
<head>
<script type="module">
import { CustomError } from './errors.js';
export class MyError extends Error {}
</script>
</head>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).toBeNull();
      });

      it('should ignore console interceptor code with errors in it', () => {
        const html = `<html>
<head>
<!-- HuskIT Console Interceptor - Auto-injected -->
<script>
window.__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__ = true;
// This code contains "Uncaught" and "TypeError" but should be ignored
console.log('Uncaught TypeError test');
</script>
</head>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).toBeNull();
      });

      it('should ignore documentation containing error keywords', () => {
        const html = `<html>
<body>
  <div class="docs">
    <h1>Error Handling Guide</h1>
    <p>This guide covers TypeError, ReferenceError, and SyntaxError handling.</p>
    <code>throw new Error('example')</code>
  </div>
</body>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).toBeNull();
      });

      it('should ignore generic "Error:" in documentation', () => {
        const html = `<html>
<body>
  <p>Error: This is a common mistake</p>
  <p>Common errors include:</p>
  <ul>
    <li>TypeError: when types don't match</li>
    <li>ReferenceError: when variables are undefined</li>
  </ul>
</body>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).toBeNull();
      });
    });

    describe('Edge cases', () => {
      it('should handle empty HTML', () => {
        const result = detectRuntimeError('');

        expect(result).toBeNull();
      });

      it('should handle HTML with no script tags', () => {
        const html = '<html><body><h1>Hello World</h1></body></html>';
        const result = detectRuntimeError(html);

        expect(result).toBeNull();
      });

      it('should handle very long error snippets (truncate)', () => {
        const longError = 'x'.repeat(1000);
        const html = `<html><body>Uncaught TypeError: ${longError}</body></html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        expect(result?.snippet.length).toBeLessThanOrEqual(504); // 500 + '...'
      });

      it('should handle multiple errors (return first)', () => {
        const html = `<html>
<body>
  <div>Uncaught ReferenceError: foo is not defined</div>
  <div>Uncaught TypeError: bar is not a function</div>
</body>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        // Should return first error found
        expect(result?.pattern).toMatch(/Uncaught/);
      });

      it('should handle mixed content (real error + false positives)', () => {
        const html = `<html>
<head>
<script>
// This is a comment with Error in it
class CustomError extends Error {}
</script>
</head>
<body>
  <vite-error-overlay>
    <div>Actual error here</div>
  </vite-error-overlay>
</body>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        expect(result?.pattern).toBe('vite-error-overlay');
      });
    });

    describe('Real-world scenarios', () => {
      it('should detect Vite dev server crash', () => {
        const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <script type="module" src="/@vite/client"></script>
    <title>Vite App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module">
      import { createApp } from 'vue'
      import App from './App.vue'
      createApp(App).mount('#app')
    </script>
    <vite-error-overlay class="error-overlay">
      <div class="error-message">
        Failed to resolve module specifier "vue"
      </div>
    </vite-error-overlay>
  </body>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).not.toBeNull();
        expect(result?.pattern).toBe('vite-error-overlay');
      });

      it('should NOT detect healthy React app', () => {
        const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + React</title>
    <script type="module" src="/@vite/client"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).toBeNull();
      });

      it('should NOT detect app with error handling code', () => {
        const html = `<!DOCTYPE html>
<html>
<head>
  <script type="module">
    // Error handling utility
    function handleError(error) {
      if (error instanceof TypeError) {
        console.error('Type error:', error);
      } else if (error instanceof ReferenceError) {
        console.error('Reference error:', error);
      } else {
        console.error('Unknown error:', error);
      }
    }

    try {
      init();
    } catch (error) {
      handleError(error);
    }
  </script>
</head>
<body>
  <div id="app"></div>
</body>
</html>`;

        const result = detectRuntimeError(html);

        expect(result).toBeNull();
      });
    });
  });

  describe('isRealError', () => {
    it('should identify real errors', () => {
      expect(isRealError('Uncaught TypeError: Cannot read property...')).toBe(true);
      expect(isRealError('ReferenceError: foo is not defined')).toBe(true);
      expect(isRealError('SyntaxError: Unexpected token')).toBe(true);
      expect(isRealError('Failed to compile')).toBe(true);
    });

    it('should filter out debug logs', () => {
      expect(isRealError('[DEBUG] log message')).toBe(false);
      expect(isRealError('[INFO] info message')).toBe(false);
      expect(isRealError('[HMR] connected')).toBe(false);
    });

    it('should filter out download notifications', () => {
      expect(isRealError('Download bundle complete')).toBe(false);
    });

    it('should filter out DevTools messages', () => {
      expect(isRealError('DevTools listening on ws://...')).toBe(false);
    });

    it('should filter out webpack info', () => {
      expect(isRealError('webpack compiled successfully')).toBe(false);
    });

    it('should filter out HMR messages', () => {
      expect(isRealError('HMR connected')).toBe(false);
      expect(isRealError('HMR updated')).toBe(false);
    });
  });
});
