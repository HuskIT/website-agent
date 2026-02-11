# Console Capture Test Harness

This test validates that console logs from an iframe can be captured and sent to the parent window via `postMessage`.

## 🎯 What This Tests

- ✅ Console interceptor script injected into preview app
- ✅ `console.log()`, `console.error()`, `console.warn()` captured
- ✅ Uncaught errors captured
- ✅ Unhandled promise rejections captured
- ✅ Messages sent from iframe → parent via postMessage
- ✅ Parent receives and displays console logs in real-time
- ✅ "Send to LLM" functionality (copies errors to clipboard)

## 🚀 Quick Start

### 1. Start Local Server

```bash
cd test-console-capture
npm start
```

This will:
- Start http-server on port 3333
- Auto-open `parent-test.html` in your browser

### 2. Test Console Capture

Once the page loads:

1. **Left Panel (Preview)**: Simulates the preview iframe with your generated website
2. **Right Panel (Console)**: Displays captured console logs in real-time

### 3. Try These Tests

Click the buttons in the preview panel:

- **console.log()** - Should appear in console panel as blue
- **console.warn()** - Should appear as orange/yellow
- **console.error()** - Should appear as red
- **Throw Error** - Captures uncaught errors
- **Promise Rejection** - Captures unhandled rejections

### 4. Verify

✅ Each click should:
1. Execute in the iframe (see output in preview panel)
2. Send postMessage to parent
3. Appear in Console panel on the right
4. Update stats (Total, Errors, Warnings)

### 5. Test "Send to LLM"

1. Click some error buttons to generate errors
2. Click **"Send Errors to LLM"** button
3. Error messages are copied to clipboard
4. Toast notification confirms success

## 📁 Files

```
test-console-capture/
├── parent-test.html       # Parent window (simulates Preview.tsx)
├── preview-app.html       # Iframe content (simulates generated website)
├── package.json           # NPM scripts
└── README.md             # This file
```

## 🔍 How It Works

### In `preview-app.html` (Iframe)

```javascript
// Console interceptor script (gets injected into generated apps)
window.parent.postMessage({
  type: 'preview-console',
  level: 'error',
  message: 'Error message here',
  timestamp: Date.now()
}, '*');
```

### In `parent-test.html` (Parent Window)

```javascript
// Listen for messages from iframe
window.addEventListener('message', (event) => {
  if (event.data?.type === 'preview-console') {
    // Display in Console panel
    appendConsoleLog(event.data.level, event.data.message);
  }
});
```

## ✅ Expected Results

After running tests, you should see:

1. **Real-time log capture**: Logs appear instantly in Console panel
2. **Proper categorization**: Logs, warnings, errors color-coded
3. **Stats update**: Counters increment correctly
4. **Error alerts**: Toast notifications for errors
5. **Export works**: Can download logs as .txt file
6. **LLM integration**: Errors copied to clipboard in proper format

## 🐛 Troubleshooting

### Logs not appearing?

- Check browser console for CORS errors
- Verify both files are served from same origin (http://localhost:3333)
- Check that postMessage is sending (look for `[Intercepted log]` in iframe's console)

### Cross-origin issues?

- This test uses same-origin (both files from localhost:3333)
- For cross-origin (like Vercel Sandbox), the iframe must inject the script itself
- The script runs IN the iframe, so it bypasses CORS restrictions

## 📝 Next Steps

Once validated:

1. ✅ Inject this script into `index.html` during file sync
2. ✅ Add Console panel to Preview.tsx
3. ✅ Wire up "Send to LLM" to chat interface
4. ✅ Handle both WebContainer and Vercel Sandbox previews

## 🔗 Integration Path

```typescript
// In workbench.ts - when syncing files to sandbox
const indexHtml = files['index.html'];
if (indexHtml) {
  // Inject console interceptor before </head>
  indexHtml.content = indexHtml.content.replace(
    '</head>',
    `<script>${consoleInterceptorScript}</script></head>`
  );
}
```

```typescript
// In Preview.tsx - listen for messages
useEffect(() => {
  const handleMessage = (event: MessageEvent) => {
    if (event.data?.type === 'preview-console') {
      setConsoleLogs(prev => [...prev, event.data]);
    }
  };
  window.addEventListener('message', handleMessage);
  return () => window.removeEventListener('message', handleMessage);
}, []);
```

## 🎉 Success Criteria

- [x] Console logs captured from iframe
- [x] Errors, warnings, logs all categorized
- [x] Real-time display in parent window
- [x] Export functionality works
- [x] "Send to LLM" copies errors to clipboard
- [x] Works with same-origin (localhost)
- [x] Will work with cross-origin (script runs IN iframe)

---

**Ready to integrate into main app!** 🚀
