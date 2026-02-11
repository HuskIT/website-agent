# Console Capture System

Automatically captures console logs, errors, and warnings from preview iframes and sends them to the LLM for fixing.

## 🎯 Features

- ✅ **Automatic injection** - Console interceptor added to all HTML files during sync
- ✅ **Separate channel** - Uses `huskit:preview-console` (no platform conflicts)
- ✅ **Immediate error alerts** - Errors shown instantly with "Ask HuskIT" button
- ✅ **Portable** - Can be embedded in templates beforehand
- ✅ **Non-blocking** - Minimal overhead, preserves original console behavior
- ✅ **Captures everything**:
  - `console.log()`, `console.error()`, `console.warn()`, `console.info()`
  - Uncaught errors
  - Unhandled promise rejections

## 🚀 How It Works

### 1. Auto-Injection During File Sync

When files are synced to the sandbox, the console interceptor is automatically injected into HTML files:

```typescript
// workbench.ts - line ~1860
if (filePath.match(/\.(html|htm)$/i) && content.includes('<html')) {
  content = injectConsoleInterceptor(content);
}
```

### 2. Script Runs in Preview Iframe

The injected script:
- Overrides console methods
- Captures all console output
- Sends via `postMessage` to parent window
- Uses dedicated channel: `huskit:preview-console`

### 3. Preview.tsx Receives Messages

```typescript
// Preview.tsx - line ~107
window.addEventListener('message', (event) => {
  if (event.data?.type === 'huskit:preview-console') {
    // Handle console message
    if (event.data.autoError) {
      // Show alert with "Ask HuskIT" button
      workbenchStore.actionAlert.set({ ... });
    }
  }
});
```

### 4. User Clicks "Ask HuskIT"

ChatAlert component sends error to LLM via chat interface.

## 📦 Portable Script

The console interceptor is a **standalone script** that can be:

### A. Auto-Injected (Current)

Automatically added during file sync - no manual action needed.

### B. Embedded in Templates

For templates that always need console capture, add to `index.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>My Template</title>

  <!-- HuskIT Console Interceptor -->
  <script>
    (function() {
      // ... interceptor code ...
    })();
  </script>
</head>
<body>
  <!-- Your template here -->
</body>
</html>
```

Get the script via:

```typescript
import { getConsoleInterceptorCode } from '~/lib/runtime/console-interceptor';

const code = getConsoleInterceptorCode();
// Embed in template
```

### C. External Script File

For templates served from CDN:

```html
<script src="https://your-cdn.com/huskit-console-interceptor.js"></script>
```

## 🔧 API Reference

### `getConsoleInterceptorCode(): string`

Returns the interceptor code as a string (for injection).

```typescript
import { getConsoleInterceptorCode } from '~/lib/runtime/console-interceptor';

const code = getConsoleInterceptorCode();
```

### `injectConsoleInterceptor(html: string): string`

Injects the interceptor into HTML content.

```typescript
import { injectConsoleInterceptor } from '~/lib/utils/inject-console-interceptor';

const html = '<html><head>...</head><body>...</body></html>';
const patched = injectConsoleInterceptor(html);
```

Strategies (in order):
1. Before `</head>` (preferred)
2. After `<head>`
3. Before `</body>`
4. At start of file

### `hasConsoleInterceptor(html: string): boolean`

Checks if HTML already has interceptor.

```typescript
if (!hasConsoleInterceptor(html)) {
  html = injectConsoleInterceptor(html);
}
```

### `removeConsoleInterceptor(html: string): string`

Removes the interceptor (for cleanup/testing).

```typescript
const clean = removeConsoleInterceptor(html);
```

## 📡 Message Format

Messages sent via `postMessage`:

```typescript
interface PreviewConsoleMessage {
  type: 'huskit:preview-console';  // Dedicated channel
  level: 'log' | 'error' | 'warn' | 'info';
  message: string;
  timestamp: number;
  url: string;
  userAgent: string;
  autoError: boolean;  // If true, trigger immediate LLM alert
}
```

### Channel Isolation

Uses `huskit:preview-console` channel to avoid conflicts with:
- Platform's own console logs
- Other postMessage systems
- Third-party scripts

## 🎨 Customization

### Modify Behavior

Edit `app/lib/runtime/console-interceptor.ts`:

```typescript
const CONFIG = {
  channel: 'huskit:preview-console',  // Change channel name
  maxMessageLength: 5000,              // Truncate long messages
  throttleMs: 50,                      // Throttle rapid-fire logs
  sendErrors: true,                    // Auto-send errors immediately
  sendWarnings: false,                 // Don't auto-send warnings
};
```

### Disable Auto-Injection

To disable automatic injection during file sync, comment out in `workbench.ts`:

```typescript
// Comment out this block to disable auto-injection
// if (filePath.match(/\.(html|htm)$/i) && content.includes('<html')) {
//   content = injectConsoleInterceptor(content);
// }
```

## ✅ Testing

Test the interceptor:

```bash
cd test-console-capture
npm start
```

This opens a test harness that:
- Simulates preview iframe
- Shows captured console logs in real-time
- Tests "Send to LLM" functionality

## 🔒 Security

- **Safe for production** - Only captures console output, doesn't modify app behavior
- **Cross-origin compatible** - Works in credentialless iframes
- **No data leakage** - Messages only sent to parent window (same tab)
- **Fail-safe** - Interceptor failures don't break the app

## 🚀 Future Enhancements

Potential additions:
- [ ] Console panel in Preview UI (show logs inline)
- [ ] Export logs as file
- [ ] Filter logs by level
- [ ] Search/highlight in logs
- [ ] Network request capture
- [ ] Performance metrics

## 📝 Example: Embed in Restaurant Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Indochine Luxe Restaurant</title>

  <!-- HuskIT Console Interceptor - Captures errors automatically -->
  <script>
    (function() {
      if (window.__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__) return;
      window.__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__ = true;

      // ... interceptor code ...

      console.error = function(...args) {
        originalConsole.error.apply(console, args);
        sendToParent('error', args, true); // Auto-send to LLM
      };
    })();
  </script>

  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <!-- Restaurant template content -->
</body>
</html>
```

When an error occurs, user sees:
```
⚠️ Runtime Error in Preview
An error occurred in the generated website. Send to HuskIT AI to fix?

[Error details...]

[Ask HuskIT] [Dismiss]
```

Clicking "Ask HuskIT" sends the error to the LLM for automatic fixing.

---

**Ready to use!** Console capture is now automatic for all generated websites. 🎉
