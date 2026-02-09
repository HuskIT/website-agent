# Error Capture Experiment

**Goal**: Empirically determine the best method to capture browser console errors from Vercel Sandbox previews for Issue 12.

## Background

Issue 12 aims to automatically capture JavaScript runtime errors from the sandbox preview and surface them to users in the chat. The challenge is that these errors occur inside an iframe with `credentialless` attribute, which creates an isolated JavaScript context.

## Test Methodology

The experiment tests **6 different capture methods** against various types of JavaScript errors:

### Test Cases

1. **ReferenceError** - Undefined variable (`Clock is not defined`)
2. **TypeError** - Cannot read property of undefined
3. **SyntaxError** - Invalid JavaScript syntax
4. **Vite Dev Server Error** - Build/compilation errors in a real Vite project

### Capture Methods Tested

| Method | Description | Pros | Cons |
|--------|-------------|------|------|
| 1. HTML Error Overlay | Fetch HTML, check for Vite error overlay or error text | Simple, works with credentialless | Only catches errors that render in DOM |
| 2. Sandbox Logs API | Access logs via Vercel SDK (if available) | Direct access to logs | Unknown if SDK exposes this |
| 3. Dev Server Output | Stream dev server stdout/stderr | Catches build errors | Doesn't capture browser runtime errors |
| 4. CDP (Chrome DevTools) | Use Chrome DevTools Protocol | Real-time, comprehensive | Requires Chrome instance, complex |
| 5. HTTP Headers | Check response headers for error signals | Fast, lightweight | Servers rarely set error headers |
| 6. Polling Detection | Periodic fetches to detect error state | Works with any method | Delayed detection, higher load |

## Running the Experiment

### Prerequisites

Ensure environment variables are set:
```bash
export VERCEL_TOKEN="your_token"
export VERCEL_TEAM_ID="your_team_id"
export VERCEL_PROJECT_ID="your_project_id"
```

### Run Test

```bash
pnpm run test:error-capture
```

Or directly:
```bash
npx tsx scripts/test-error-capture.ts
```

### Expected Output

```
🚀 Starting Error Capture Experiment
════════════════════════════════════════════════════════════════════════════════

════════════════════════════════════════════════════════════════════════════════
Test Case: ReferenceError - Undefined Variable
════════════════════════════════════════════════════════════════════════════════

📦 Creating sandbox...
✅ Sandbox created: sbx_abc123...

📝 Writing test HTML...
🚀 Starting HTTP server...
🌐 Preview URL: https://abc123-5173.csb.app

🔍 Testing capture methods...

📊 Results:

✅ DETECTED | HTML Error Overlay Detection
  └─ Error: ReferenceError
  └─ Response time: 234ms
  └─ Notes: HTML size: 1024 bytes

❌ Not detected | Sandbox Logs API
  └─ Notes: No logs API available

...
```

## Expected Findings

Based on the architectural constraints, we expect:

### ✅ Likely to Work

- **HTML Error Overlay Detection** - Vite displays errors in the DOM, fetchable via HTTP
- **Polling Detection** - Multiple fetches increase chance of catching persistent errors

### ❓ Uncertain

- **Sandbox Logs API** - Depends on what Vercel SDK exposes
- **Dev Server Output** - May catch build errors but not runtime errors

### ❌ Unlikely to Work

- **CDP** - Requires Chrome instance, not available in our environment
- **HTTP Headers** - Standard servers don't set error headers

## Next Steps Based on Results

### If HTML Error Overlay Works ✅

**Implementation Path**: Extend `/api/sandbox/health` endpoint
```typescript
// In api.sandbox.health.ts
const html = await response.text();
const hasViteError = html.includes('vite-error-overlay');
const hasRuntimeError = /Uncaught (Reference|Type|Syntax)Error/.test(html);

return json({
  ready: !hasViteError && !hasRuntimeError,
  error: hasViteError || hasRuntimeError ? {
    type: 'runtime',
    detected: true,
    snippet: extractErrorSnippet(html)
  } : null
});
```

**Polling Strategy**:
- Poll every 10s when dev server is running
- Stop polling once error detected and alert shown
- Resume polling after user clicks "Ask HuskIT" and fix is applied

**Pros**:
- No iframe script injection needed ✓
- Works with credentialless iframes ✓
- Leverages existing infrastructure ✓
- Simple implementation (~50 lines) ✓

**Cons**:
- 10-second delay to detection ⚠️
- Only catches persistent errors (not transient) ⚠️
- Adds server load (polling overhead) ⚠️

**Decision**: Implement this as 80/20 solution if test confirms it works.

### If Sandbox Logs API Works ✅

**Implementation Path**: Use Vercel SDK logs directly
```typescript
const logs = await sandbox.getLogs({
  filter: 'error',
  since: lastCheckTimestamp
});
```

**Pros**:
- Direct access to logs ✓
- No HTML parsing needed ✓
- Real-time potential ✓

**Cons**:
- Depends on undocumented API ⚠️
- May not capture browser console errors ⚠️

### If Nothing Works ❌

**Fallback Path**: Script injection (complex)
```typescript
// Inject error capture script into HTML
const errorCaptureScript = `
  window.addEventListener('error', (e) => {
    parent.postMessage({
      type: 'SANDBOX_ERROR',
      error: e.error?.stack
    }, '*');
  });
`;
```

Requires:
1. Proxying HTML responses to inject script
2. OR modifying Vite config to include script
3. OR using Vercel Sandbox API to inject (if available)

**Complexity**: High ⚠️⚠️⚠️

## Interpreting Results

### Success Criteria

A method is considered **successful** if it:
1. Detects the intentional error ✓
2. Provides usable error information (message, type) ✓
3. Works consistently across test cases ✓
4. Can be implemented without major architectural changes ✓

### Prioritization

1. **Speed of detection** - Faster is better (real-time > 10s > 30s)
2. **Implementation complexity** - Simpler is better (extend existing > new infra)
3. **Reliability** - Consistent detection across error types
4. **Resource usage** - Lower server load is better

## Notes

- This experiment uses **real Vercel sandboxes** to ensure accurate results
- Each test creates and destroys a sandbox (cost: minimal, test duration: ~30s each)
- The script is idempotent - safe to run multiple times
- Results may vary based on network conditions and Vercel API response times

## Questions to Answer

1. ✅/❌ Does Vite error overlay appear in fetched HTML?
2. ✅/❌ Does Vercel SDK expose sandbox logs?
3. ✅/❌ Can we detect errors via dev server stderr?
4. ⏱️ What is the average detection time for each method?
5. 📊 Which method has the highest detection rate?
6. 💡 Are there unexpected methods that work?

---

**Status**: Ready to run
**Expected Duration**: ~2 minutes per test case
**Risk**: Low (uses temporary sandboxes, auto-cleanup)
