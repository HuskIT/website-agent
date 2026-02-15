# Implementation Plan: Fix URL-Sandbox Connection

## Overview
Prevent URL slug changes from disconnecting the sandbox by removing `navigateChat()` calls that change the URL to non-project IDs.

## Problem
When `navigateChat()` changes the URL to artifact IDs or local chat IDs, the `chat.$id.tsx` loader cannot resolve the project, returns `projectId: null`, and the sandbox fails to initialize.

## Solution
Comment out `navigateChat()` calls while keeping internal state updates. The URL remains stable on the initial project/chat ID.

## Changes Required

### File: `app/lib/persistence/useChatHistory.ts`

#### Change 1: Lines 903-908 (Artifact-based URL generation)
**Current:**
```typescript
if (!urlId && firstArtifact?.id) {
  const urlId = await getUrlId(db, firstArtifact.id);
  _urlId = urlId;
  navigateChat(urlId);  // ❌ Changes URL
  setUrlId(urlId);
}
```

**Proposed:**
```typescript
if (!urlId && firstArtifact?.id) {
  const newUrlId = await getUrlId(db, firstArtifact.id);
  _urlId = newUrlId;
  /*
   * URL navigation removed - URL should remain stable based on initial project/chat ID
   * navigateChat(urlId);
   */
  setUrlId(newUrlId);  // ✅ Only sets internal state
}
```

#### Change 2: Lines 952-954 (New chat URL navigation)
**Current:**
```typescript
if (!urlId) {
  navigateChat(nextId);  // ❌ Changes URL
}
```

**Proposed:**
```typescript
/*
 * URL navigation removed - URL should remain stable based on initial project/chat ID
 * if (!urlId) {
 *   navigateChat(nextId);
 * }
 */
```

#### Change 3: Line 1148 (Rename function)
**Current:**
```typescript
function navigateChat(nextId: string) {
```

**Proposed:**
```typescript
function _navigateChat(nextId: string) {
```

## Why This Works

1. **URL stays stable**: The browser URL remains on the initial project ID
2. **Loader always resolves**: `chat.$id.tsx` loader finds the project by `url_id` or `id`
3. **Sandbox initializes**: `useChatHistory` receives correct `projectId` and connects sandbox
4. **Internal state updates**: `setUrlId()` and `chatId.set()` still track state without URL changes

## Testing Checklist

- [ ] Create new project → URL should use `url_id`, never change to artifact IDs
- [ ] Reload page → Sandbox should reconnect to same project
- [ ] Navigate between projects → Each should maintain stable URL
- [ ] Check browser history → No unexpected URL changes

## Backwards Compatibility

✅ Existing projects with `url_id` continue to work
✅ Projects navigated by UUID fallback continue to work
✅ Only removes problematic URL-changing behavior

## Risk Assessment

**Low Risk**: The `navigateChat` function already has a FIXME comment indicating it was a workaround. The comment explicitly states the intended `navigate()` function "breaks the app" - our fix simply stops using this problematic workaround.

## Estimated Effort

**Small**: 3 lines of code changes, purely comment-outs and renaming.
