# Console Interceptor Improvements

## Problem

The console interceptor was generating **false positive error alerts** that disrupted the user experience. Users would see "Preview Error" alerts even when their generated websites were working correctly.

## Root Causes

### 1. Overly Broad Error Patterns

The health check API (`api.sandbox.health.ts`) used patterns that were too generic:

```javascript
// ❌ OLD - Too broad
const ERROR_PATTERNS = [
  'Error:',        // Matches ANY text containing "Error:"
  'TypeError',     // Matches code comments, documentation, etc.
  'ReferenceError',
  'SyntaxError',
  // ...
];
```

This would match:
- ✅ **Actual errors**: `Uncaught TypeError: Cannot read property...`
- ❌ **Code comments**: `// This handles TypeError correctly`
- ❌ **Documentation**: `Error: Common mistake to avoid`
- ❌ **Error classes**: `class CustomError extends Error`
- ❌ **Try-catch blocks**: `catch (error) { ... }`
- ❌ **Console interceptor code**: Contains "Uncaught" in comments

### 2. Continuous Error Polling

The Preview component polled for errors **every 10 seconds** (line 305-364), so any false positive would keep triggering.

### 3. Insufficient Code Filtering

The original console interceptor stripping only worked when markers were present, and didn't handle all injection formats.

## Solution

### 1. Smart Error Pattern Filter (`error-pattern-filter.ts`)

**New Features:**

✅ **Context-Aware Detection**: Checks if error text is in code vs. actual runtime errors

✅ **Multi-Method Interceptor Stripping**: Removes console interceptor code reliably:
- By `/* HUSKIT_CONSOLE_INTERCEPTOR_START */` markers
- By `<!-- HuskIT Console Interceptor -->` comments
- By `__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__` flag

✅ **Smart False Positive Filtering**: Ignores:
- Single-line comments (`// Error handling`)
- Multi-line comments (`/* TypeError info */`)
- Class definitions (`class CustomError`)
- Try-catch blocks (`catch (error)`)
- Console calls (`console.error()`)
- Import/export statements
- Throw statements (`throw new Error()`)

✅ **Specific Error Patterns**: Only detects actual runtime errors:
```javascript
{
  pattern: /Uncaught\s+(ReferenceError|TypeError|SyntaxError)/,
  context: 'text',
  description: 'Uncaught JavaScript exceptions'
},
{
  pattern: 'vite-error-overlay',
  context: 'element',
  description: "Vite's error overlay component"
},
// ... more specific patterns
```

### 2. Updated Health Check API

**Before:**
```javascript
const detectedError = ERROR_PATTERNS.find(pattern => text.includes(pattern));
```

**After:**
```javascript
import { detectRuntimeError } from '~/lib/utils/error-pattern-filter';

const errorDetection = detectRuntimeError(text);
if (errorDetection) {
  return json({
    ready: false,
    error: {
      type: 'runtime',
      pattern: errorDetection.pattern,
      snippet: errorDetection.snippet,
      description: errorDetection.description,
    }
  });
}
```

### 3. Comprehensive Test Coverage

**39 tests** covering:
- ✅ Interceptor stripping (all formats)
- ✅ Real error detection (10 types)
- ✅ False positive filtering (10 scenarios)
- ✅ Edge cases (empty HTML, long snippets, etc.)
- ✅ Real-world scenarios (Vite, React, error handling code)

## Testing

Run tests locally:

```bash
# Run all console interceptor tests
pnpm test error-pattern-filter

# Watch mode for development
pnpm test:watch error-pattern-filter
```

## Examples

### ✅ Real Errors (Will Trigger Alert)

```html
<!-- Vite error overlay -->
<vite-error-overlay class="error-overlay">
  <div>Build failed</div>
</vite-error-overlay>

<!-- Uncaught exception -->
<body>Uncaught TypeError: Cannot read property 'x' of undefined</body>

<!-- Build failure -->
<body>Build failed with 3 errors</body>

<!-- Module resolution -->
<body>Failed to resolve module "vue"</body>
```

### ❌ False Positives (Will NOT Trigger Alert)

```html
<!-- Code comments -->
<script>
// This handles TypeError correctly
function handleError() { ... }
</script>

<!-- Error class definitions -->
<script>
class CustomError extends Error {
  constructor(message) {
    super(message);
  }
}
</script>

<!-- Try-catch blocks -->
<script>
try {
  doSomething();
} catch (error) {
  console.error(error);
}
</script>

<!-- Documentation -->
<div class="docs">
  <h1>Error Handling Guide</h1>
  <p>Common errors: TypeError, ReferenceError</p>
</div>

<!-- Console interceptor code (auto-stripped) -->
<!-- HuskIT Console Interceptor - Auto-injected -->
<script>
window.__HUSKIT_CONSOLE_INTERCEPTOR_INSTALLED__ = true;
console.log('Uncaught Error'); // This is stripped!
</script>
```

## Migration Notes

### No Breaking Changes

The improvements are **backwards compatible**. Existing code continues to work:

- Console interceptor injection still works the same
- Health check API signature unchanged
- Preview component behavior unchanged

### Reduced Noise

Users will see **significantly fewer false alerts**:
- Before: Alerts for code comments, documentation, error handling
- After: Alerts only for actual runtime errors

### Better Error Messages

When real errors are detected, the alert now includes:
- **Pattern**: What error pattern was matched
- **Snippet**: Context around the error
- **Description**: What type of error it is

Example:
```json
{
  "type": "runtime",
  "pattern": "Uncaught TypeError",
  "snippet": "Uncaught TypeError: Cannot read property 'foo' of undefined at App.jsx:42",
  "description": "Uncaught JavaScript exceptions"
}
```

## Future Improvements

Potential enhancements:
- [ ] Add error severity levels (warning vs. error)
- [ ] Smart de-duplication (same error from multiple files)
- [ ] Error context extraction (file, line, column)
- [ ] Integration with source maps for better stack traces
- [ ] Machine learning-based error classification

## Related Files

- `app/lib/utils/error-pattern-filter.ts` - Smart error detection
- `app/routes/api.sandbox.health.ts` - Health check API (updated)
- `tests/unit/utils/error-pattern-filter.test.ts` - Test suite (39 tests)
- `app/lib/runtime/console-interceptor.ts` - Console interceptor code
- `app/components/workbench/Preview.tsx` - Preview component with error polling

## Debugging

If you suspect false positives/negatives:

1. **Enable debug logging** (in browser console):
```javascript
localStorage.setItem('DEBUG_ERROR_DETECTION', 'true');
```

2. **Check health check response**:
```bash
curl -X POST http://localhost:5171/api/sandbox/health \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-sandbox.vercel.run"}'
```

3. **Test error detection locally**:
```javascript
import { detectRuntimeError } from '~/lib/utils/error-pattern-filter';

const html = `<html>...your html...</html>`;
const result = detectRuntimeError(html);
console.log(result);
```

## Support

If you encounter issues:
1. Check the test suite for similar scenarios
2. Review the error patterns in `error-pattern-filter.ts`
3. File an issue with the HTML content that triggered the false positive

---

**Status**: ✅ All tests passing (39/39)
**Deployed**: Ready for production use
**Breaking Changes**: None
