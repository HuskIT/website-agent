# Fix: URL Slug Changes Disconnect Sandbox

## Problem Summary

When the URL slug changes from the project's `url_id` to something else (like artifact IDs or timestamps), the `chat.$id.tsx` loader cannot resolve the project, returns `projectId: null`, and the sandbox connection is lost.

### Affected URLs
- `/chat/glada-g-sen-t4q5p0` → `url_id` (works)
- `/chat/restored-project-setup` → artifact ID (breaks)
- `/chat/1769751368273` → timestamp/local ID (breaks)

## Root Cause

In `useChatHistory.ts`, the code was calling `navigateChat(urlId)` to change the URL when:
1. A new `urlId` was generated from an artifact ID
2. A new local chat was created

This caused the URL to change to non-project IDs, breaking the project-sandbox connection.

## Solution (from fix/sandbox-editing-flow branch)

The fix is to **remove URL navigation** and keep the URL stable based on the initial project/chat ID.

### Key Changes Needed

1. **useChatHistory.ts: Lines 898-908**
   - Comment out `navigateChat(urlId)` call
   - Keep only `setUrlId(newUrlId)` for internal tracking
   - Add comment explaining URL stability

2. **useChatHistory.ts: Lines 962-968**
   - Comment out `navigateChat(nextId)` call
   - Keep only `chatId.set(nextId)` for internal tracking
   - Add comment explaining URL stability

3. **Rename navigateChat to _navigateChat**
   - Make it clear this function should not be used
   - Keep for future reference or debugging

### Code Changes

```typescript
// BEFORE (problematic):
if (!urlId && firstArtifact?.id) {
  const urlId = await getUrlId(db, firstArtifact.id);
  _urlId = urlId;
  navigateChat(urlId);  // ❌ Changes URL to artifact-based ID
  setUrlId(urlId);
}

// AFTER (fixed):
if (!urlId && firstArtifact?.id) {
  const newUrlId = await getUrlId(db, firstArtifact.id);
  _urlId = newUrlId;
  /*
   * URL navigation removed - URL should remain stable based on initial project/chat ID
   * navigateChat(urlId);
   */
  setUrlId(newUrlId);  // ✅ Only sets internal state, doesn't change URL
}
```

```typescript
// BEFORE (problematic):
if (!urlId) {
  navigateChat(nextId);  // ❌ Changes URL to local chat ID
}

// AFTER (fixed):
/*
 * URL navigation removed - URL should remain stable based on initial project/chat ID
 * if (!urlId) {
 *   navigateChat(nextId);
 * }
 */
```

## Benefits

1. **Stable project-sandbox connection**: URL never changes, so loader always resolves to same project
2. **No more "orphaned" sandboxes**: Sandbox stays connected to the correct project
3. **Better UX**: Users don't see URL changing unexpectedly
4. **Consistent behavior**: Works the same for new projects and restored projects

## Testing Checklist

- [ ] Create new project → URL should use `url_id`, not change
- [ ] Restore from snapshot → URL should stay the same
- [ ] Send messages → URL should not change
- [ ] Reload page → Sandbox should reconnect to same project
- [ ] Navigate between projects → Each should have stable URL

## Related Files

- `app/lib/persistence/useChatHistory.ts` (main fix)
- `app/routes/chat.$id.tsx` (loader resolution)
- `app/components/projects/ProjectList.tsx` (project navigation)

## Backwards Compatibility

This change is backwards compatible:
- Existing projects with `url_id` continue to work
- Projects navigated by UUID fallback continue to work
- Only removes the problematic URL-changing behavior
