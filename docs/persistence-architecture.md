# Project Persistence Architecture

## Overview

The website-agent implements a sophisticated multi-tier persistence system that handles three types of data:
1. **Chat Messages** - Conversation history between user and AI
2. **Generated Code** - Files created/edited by the AI
3. **Project State** - Complete snapshots of the project at specific points

This document explains how each type of data is saved, synchronized, and restored.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER INTERACTIONS                          │
│              (Chat Input, Code Edits, File Actions)               │
└────────────────────────┬──────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         v               v               v
    ┌────────┐    ┌──────────┐    ┌──────────┐
    │  Chat  │    │  Editor  │    │ Terminal │
    │Messages│    │  Changes │    │ Commands │
    └───┬────┘    └────┬─────┘    └────┬─────┘
        │              │               │
        └──────────────┼───────────────┘
                       │
        ┌──────────────┴───────────────┐
        │                              │
        v                              v
┌──────────────────┐         ┌──────────────────┐
│  TIER 1: RUNTIME │         │  TIER 1: RUNTIME │
│                  │         │                  │
│  • useChat hook  │         │ • WebContainer FS│
│  • messages[]    │         │ • Nanostores     │
│  • streaming     │         │ • File watcher   │
└────────┬─────────┘         └────────┬─────────┘
         │                            │
         v                            v
┌──────────────────┐         ┌──────────────────┐
│ TIER 2: BROWSER  │         │ TIER 2: BROWSER  │
│                  │         │                  │
│  IndexedDB       │         │  IndexedDB       │
│  • chats         │         │  • snapshots     │
│  • messages      │         │  • files (JSONB) │
└────────┬─────────┘         └────────┬─────────┘
         │                            │
         v                            v
┌──────────────────┐         ┌──────────────────┐
│ TIER 3: SERVER   │         │ TIER 3: SERVER   │
│                  │         │                  │
│  Supabase        │         │  Supabase        │
│  • projects      │         │  • snapshots     │
│  • messages      │         │  • files (JSONB) │
└──────────────────┘         └──────────────────┘
```

---

## Storage Tiers

### Tier 1: Runtime (In-Memory)

**Purpose:** Active session state, immediate access, real-time updates

**Components:**
- `useChat` hook from Vercel AI SDK - manages streaming messages
- WebContainer virtual file system - browser-based Node.js environment
- Nanostores - reactive state management for UI updates

**Lifetime:** Current session only (lost on page refresh)

**Key Feature:** Hot Module Reload (HMR) preservation via `import.meta.hot.data`

---

### Tier 2: Browser Storage (Client-Side Persistent)

**Purpose:** Offline capability, instant restore, single-browser persistence

**Technology:** IndexedDB database named `boltHistory`

**Schema:**
```typescript
// Store 1: 'chats'
interface ChatHistoryItem {
  id: string                    // Internal ID
  urlId: string                // URL-friendly ID
  messages: Message[]           // Complete conversation
  description?: string          // Chat title
  timestamp: string
  metadata?: IChatMetadata
}

// Store 2: 'snapshots'
interface Snapshot {
  chatId: string               // Links to chat
  snapshot: {
    chatIndex: string          // Message ID where snapshot was taken
    files: FileMap             // Complete file tree (JSONB)
    summary?: string
    created_at?: string
    updated_at?: string
  }
}
```

**Lifetime:** Persists across sessions, browser-specific

**Size Limits:**
- Browser-dependent (typically 50MB - 500MB per origin)
- Snapshots limited to 50MB (warned at 45MB)

---

### Tier 3: Server Storage (Cloud Persistent)

**Purpose:** Multi-device sync, backup, authentication-based access

**Technology:** Supabase PostgreSQL with Row-Level Security (RLS)

**Database Schema:**

```sql
-- Projects table (parent)
CREATE TABLE projects (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,              -- Owner (RLS enforced)
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(50),
  url_id VARCHAR(255) UNIQUE,         -- URL slug
  business_profile JSONB,             -- Google Maps data
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

-- Messages table (child)
CREATE TABLE project_messages (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,           -- Client-generated UUID
  sequence_num INTEGER NOT NULL,      -- Server-allocated ordering
  role TEXT NOT NULL,                 -- 'user' | 'assistant' | 'system'
  content JSONB NOT NULL,             -- Message content (text, arrays, objects)
  annotations JSONB,                  -- Metadata (context, summaries)
  created_at TIMESTAMPTZ,
  UNIQUE(project_id, sequence_num),
  UNIQUE(project_id, message_id)
);

-- Snapshots table (child)
CREATE TABLE project_snapshots (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  files JSONB NOT NULL,               -- Complete FileMap
  summary TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  UNIQUE(project_id)                  -- One snapshot per project
);
```

**RLS Policies:**
- Users can only access their own projects and data
- Server role can bypass RLS for system operations
- `app.current_user_id` set via `auth.server.ts` on every request

---

## Chat Message Persistence

### Message Flow

```
1. USER SENDS MESSAGE
   ↓
   Chat.client.tsx: append({ role: 'user', content })
   ↓
   POST /api/chat (SSE streaming)
   ↓
   LLM streams response chunks
   ↓
   useChat hook updates messages[] array
   ↓

2. STREAM COMPLETES
   ↓
   processSampledMessages sampler (50ms debounce)
   ↓
   storeMessageHistory() called
   ↓

3. DUAL WRITE
   ↓
   ├─→ IndexedDB: setMessages(db, chatId, messages)
   │
   └─→ Server (if authenticated + projectId):
       POST /api/projects/:id/messages/append
       ↓
       Server allocates sequence_num (ordering)
       ↓
       INSERT INTO project_messages
       ON CONFLICT (project_id, message_id) DO NOTHING
```

### Message Deduplication

**Client-Side:**
```typescript
// Filter out messages not meant for storage
const unsyncedMessages = messages.filter(m => {
  const annotations = extractMessageAnnotations(m);
  return !annotations.includes('hidden') &&
         !annotations.includes('no-store');
});
```

**Server-Side:**
```sql
-- Prevent duplicates using unique constraint
INSERT INTO project_messages (project_id, message_id, ...)
VALUES (...)
ON CONFLICT (project_id, message_id) DO NOTHING;
```

### Sync State Management

**Location:** `app/lib/persistence/messageSyncState.ts`

**Stores:**
```typescript
// Track messages awaiting server sync
pendingMessageIdsStore: Map<projectId, Set<messageId>>

// Track sync errors
syncErrorsStore: Map<projectId, SyncError>

// Computed UI state
computeSyncStatus() → {
  hasPending: boolean,
  hasError: boolean,
  pendingCount: number
}
```

**Annotations:**
- `'pending-sync'`: Message queued for server sync
- `'sync-error'`: Last sync attempt failed
- `'hidden'`: Internal message, not shown to user
- `'no-store'`: Ephemeral message, not persisted

### Background Sync

**Trigger Points:**
1. After streaming completes (immediate)
2. When user authenticates (background, 2s delay)
3. Manual retry via UI button

**Retry Logic:**
```typescript
// Auto-retry on authentication
useEffect(() => {
  if (isUserAuthenticated() && projectId) {
    setTimeout(() => checkAndSyncPending(), 2000);
  }
}, [isUserAuthenticated, projectId]);

// Manual retry
async function retrySync() {
  const pendingIds = getPendingMessageIds(projectId);
  const messagesToSync = messages.filter(m => pendingIds.has(m.id));

  await appendServerMessages(projectId, messagesToSync);

  // Show success/error toast
}
```

---

## File & Code Persistence

### File Storage Layers

**1. WebContainer Virtual File System**

```typescript
// Location: app/lib/webcontainer/index.ts
const webcontainer = await WebContainer.boot({
  coep: 'credentialless',
  workdirName: '/home/project'
});

// Write file
await webcontainer.fs.writeFile('src/App.tsx', content);

// Read file
const content = await webcontainer.fs.readFile('src/App.tsx', 'utf-8');

// Watch for changes
webcontainer.fs.watch('/home/project/**', (events) => {
  // Update Nanostores on file change
});
```

**Characteristics:**
- In-memory only (not persisted)
- Runs actual Node.js in browser
- Lost on page refresh
- Syncs to Nanostores via file watcher

---

**2. Nanostores File Map**

```typescript
// Location: app/lib/stores/files.ts
export interface File {
  type: 'file';
  content: string;
  isBinary: boolean;
  isLocked?: boolean;
}

export interface Folder {
  type: 'folder';
  isLocked?: boolean;
}

export type FileMap = Record<string, File | Folder | undefined>;

// Reactive store
files: MapStore<FileMap> = map({
  'src/App.tsx': {
    type: 'file',
    content: 'import React from "react";\n...',
    isBinary: false
  },
  'package.json': {
    type: 'file',
    content: '{\n  "name": "my-app"\n}',
    isBinary: false
  },
  'node_modules': { type: 'folder' }
});
```

**Key Features:**
- Reactive updates (UI automatically reflects changes)
- Modification tracking via `#modifiedFiles: Map<path, originalContent>`
- Deletion tracking via `#deletedPaths: Set<path>`
- HMR preservation via `import.meta.hot.data`
- Lock system for protecting files/folders

---

**3. IndexedDB Snapshot Storage**

```typescript
// Snapshot stored in 'snapshots' object store
{
  chatId: 'abc-123',
  snapshot: {
    chatIndex: 'msg-456',           // Last message ID
    files: {                        // Complete file tree
      'src/App.tsx': {
        type: 'file',
        content: '...',
        isBinary: false
      },
      'package.json': { ... }
    },
    summary: 'Restaurant website with menu',
    created_at: '2024-01-15T10:30:00Z'
  }
}
```

---

**4. Supabase Snapshot Storage**

```sql
-- project_snapshots table
{
  id: 'uuid-789',
  project_id: 'project-uuid',
  files: {                          -- JSONB column
    "src/App.tsx": {
      "type": "file",
      "content": "import React...",
      "isBinary": false
    },
    "package.json": { ... }
  },
  summary: 'Restaurant website with menu',
  updated_at: '2024-01-15T10:30:00Z'
}
```

---

### File Write Flow

**When User Edits:**

```
1. USER TYPES IN EDITOR
   ↓
   Editor onChange event
   ↓
   workbenchStore.setCurrentDocumentContent(newContent)
   ↓
   editorStore.updateFile(path, newContent)
   ↓
   Mark as unsaved: unsavedFiles.set(path, true)

2. USER SAVES (Cmd+S)
   ↓
   workbenchStore.saveFile(path, content)
   ↓
   filesStore.saveFile(path, content)
   ↓
   webcontainer.fs.writeFile(path, content)
   ↓
   Track in #recentlySavedFiles (prevents watcher race)
   ↓
   File watcher detects change → updates Nanostores
   ↓
   Clear unsaved flag
```

---

**When LLM Generates Code:**

```
1. AI STREAMS FILE ACTION
   ↓
   SSE stream: <boltAction type="file" filePath="src/App.tsx">
   ↓
   MessageParser extracts action
   ↓
   ActionRunner queues execution

2. ACTION EXECUTION
   ↓
   actionRunner.#runFileAction(action)
   ↓
   Create parent directories if needed
   ↓
   webcontainer.fs.writeFile(filePath, content)
   ↓
   File watcher updates Nanostores
   ↓
   editorStore syncs (if file open in editor)
   ↓
   Track modification: #modifiedFiles.set(path, originalContent)
```

---

### Snapshot System

**What is a Snapshot?**

A snapshot captures the **complete state** of a project at a specific point in the conversation. It includes:
- All files and their contents
- File structure (folders)
- Optional summary text
- Timestamp of when it was taken

**When Snapshots Are Created:**

1. **Automatic** - After LLM completes file generation
2. **Manual** - User clicks "Save Snapshot" button
3. **Navigation** - Before navigating away from project

**Snapshot Save Flow:**

```
1. TRIGGER SNAPSHOT SAVE
   ↓
   workbenchStore.waitForActionsToComplete()  // Wait for pending file writes
   ↓
   workbenchStore.saveAllFiles()              // Flush editor changes
   ↓

2. GATHER CURRENT STATE
   ↓
   const files = workbenchStore.files.get()
   const lastMessageId = messages[messages.length - 1].id
   ↓
   const snapshot = {
     chatIndex: lastMessageId,
     files: files,                            // Complete FileMap
     summary: chatStore.summary.get(),
     created_at: new Date().toISOString()
   }

3. VALIDATE SIZE
   ↓
   const sizeInMB = JSON.stringify(snapshot.files).length / (1024 * 1024)
   if (sizeInMB > 50) throw new Error('Snapshot too large')

4. DUAL SAVE
   ↓
   ├─→ IndexedDB: setSnapshot(db, chatId, snapshot)
   │   ↓
   │   Transaction committed
   │
   └─→ Server (if authenticated):
       PUT /api/projects/:id/snapshot
       ↓
       Server validates ownership
       ↓
       UPSERT INTO project_snapshots
       (project_id, files, summary, updated_at)
       ON CONFLICT (project_id) DO UPDATE
```

**Snapshot Restore Flow:**

```
1. LOAD PROJECT
   ↓
   GET /api/projects/:id/snapshot (or from IndexedDB)
   ↓
   Receive: { files: FileMap, summary, created_at }

2. CREATE RESTORATION MESSAGE
   ↓
   Build artificial assistant message with bundled file actions:

   <boltArtifact type="bundled">
     <boltAction type="file" filePath="src/App.tsx">
       [file content]
     </boltAction>
     <boltAction type="file" filePath="package.json">
       [file content]
     </boltAction>
     ...
   </boltArtifact>

3. EXECUTE ACTIONS
   ↓
   For each file action:
     ├─→ webcontainer.fs.mkdir(parentDir, { recursive: true })
     ├─→ webcontainer.fs.writeFile(filePath, content)
     ├─→ filesStore.files.setKey(filePath, { type: 'file', content })
     └─→ editorStore.updateFile(filePath, content)

4. UI UPDATE
   ↓
   Nanostores reactively update UI
   ↓
   Editor displays restored files
   ↓
   File tree shows complete structure
   ↓
   Show banner: "Restored from snapshot"
```

---

## Loading Historical Messages and Files

### Overview

When a user navigates to an existing chat (e.g., `/chat/:id`), the system loads both the conversation history and the project files through a sophisticated multi-stage process. This ensures the chat screen displays the full context with minimal loading time.

**Implementation:** `app/lib/persistence/useChatHistory.ts` (Lines 88-455)

---

### Initial Load Flow

```
User navigates to /chat/:id or /chat/project-url-slug
   ↓
useChatHistory hook initializes
   ↓
loadMessages() async function runs
   ↓
┌──────────────────────────────────────┐
│  STAGE 1: Reset State                │
│  - Clear previous chat data          │
│  - Reset loading state               │
│  - Invalidate stale data             │
└──────────────────────────────────────┘
   ↓
┌──────────────────────────────────────┐
│  STAGE 2: Load from Storage          │
│  - Try Server (if authenticated)     │
│  - Fallback to IndexedDB             │
│  - Load messages + snapshot          │
└──────────────────────────────────────┘
   ↓
┌──────────────────────────────────────┐
│  STAGE 3: Process & Sort             │
│  - Sort by sequence_num              │
│  - Find snapshot index               │
│  - Determine message range           │
└──────────────────────────────────────┘
   ↓
┌──────────────────────────────────────┐
│  STAGE 4: Restore Snapshot           │
│  - Create synthetic message          │
│  - Restore files to WebContainer     │
│  - Skip archived messages            │
└──────────────────────────────────────┘
   ↓
Chat UI displays with full context
```

---

### Stage 1: State Reset (Lines 92-104)

**Purpose:** Prevent stale data from previous chats

```typescript
// Reset ALL state before loading
setReady(false);
setInitialMessages([]);
setArchivedMessages([]);
setUrlId(undefined);
loadedIdRef.current = undefined; // Invalidate immediately

// Reset loading state
setLoadingState(initialLoadingState);
setTotalServerMessages(null);
setLoadedServerMessages(0);
```

**Why This Matters:**
- Users may navigate between multiple chats rapidly
- Prevents showing messages from Chat A while loading Chat B
- `loadedIdRef` tracks which chat the current data belongs to

---

### Stage 2: Storage Loading (Lines 113-251)

#### Server Storage (Primary - Lines 113-183)

**Conditions:**
- `projectId` is provided
- User is authenticated (`isUserAuthenticated()`)

**Process:**
```typescript
// Update UI to show loading from server
setLoadingState({ phase: 'server', loaded: 0, total: null });

// Load messages with pagination progress tracking
const onProgress = (progress) => {
  setLoadedServerMessages(progress.loaded);
  setTotalServerMessages(progress.total);
};

// Parallel loading for speed
const [serverMessages, serverSnapshot] = await Promise.all([
  getServerMessages(projectId, onProgress),
  getServerSnapshot(projectId)
]);
```

**Pagination Details:**
- Default page size: 50 messages (`MESSAGE_PAGE_SIZE`)
- Maximum pages: 20 (`MAX_MESSAGE_PAGES` = 1000 messages)
- Progress callback updates UI in real-time
- Rate limiting detection shows partial load state

**Server as Source of Truth:**
```typescript
// When server load succeeds, skip IndexedDB merge
// This prevents stale local data from overriding fresh server data
serverLoadAttempted = true;
logger.info('Loaded from server', { messageCount: messages.length });
```

---

#### IndexedDB Fallback (Lines 184-251)

**Triggers When:**
- Server request fails (offline, network error)
- User is not authenticated
- `projectId` not provided (local-only chat)

**Process:**
```typescript
// Fall back to client storage
setLoadingState({ phase: 'local', isPartial: true });

const [clientMessages, clientSnapshot] = await Promise.all([
  getMessages(db, mixedId),
  getSnapshot(db, mixedId)
]);

// Show warning to user
toast.warning('Loaded from local cache - server unavailable');
```

**Important:** If server load succeeded (even with 0 messages), IndexedDB is **NOT** consulted. This prevents merge conflicts.

---

### Stage 3: Message Processing (Lines 254-289)

#### Message Sorting

**Critical:** Messages must be sorted by `sequence_num` (server-allocated ordering)

```typescript
// Server messages may arrive out of order due to pagination
const sortedMessages = sortMessagesBySequence(storedMessages.messages);
storedMessages.messages = sortedMessages;
```

**Why Sorting Matters:**
- Pagination loads newest messages first
- Older messages loaded on-demand may be inserted
- `sequence_num` ensures chronological order

---

#### Snapshot Index Detection (Lines 269-289)

**Purpose:** Determine which messages to show vs. archive

```typescript
const validSnapshot = snapshot || { chatIndex: '', files: {} };
const snapshotIndex = storedMessages.messages.findIndex(
  (m) => m.id === validSnapshot.chatIndex
);

let startingIdx = -1;

if (snapshotIndex >= 0 && snapshotIndex < endingIdx) {
  startingIdx = snapshotIndex; // Start from snapshot point
}

// Messages before snapshot → archived (not shown initially)
const archivedMessages = storedMessages.messages.slice(0, startingIdx + 1);

// Messages after snapshot → shown in chat
const filteredMessages = storedMessages.messages.slice(startingIdx + 1, endingIdx);
```

**Optimization:**
- Messages before the snapshot are archived
- User doesn't need to replay entire conversation
- Files are restored directly from snapshot
- Can load full history via "Load older messages"

---

### Stage 4: Snapshot Restoration (Lines 293-367)

#### Creating the Restoration Message (Lines 311-362)

**When:** `startingIdx > 0` (snapshot exists and was found)

**Process:**

```typescript
// 1. Detect project commands (npm install, etc.)
const projectCommands = await detectProjectCommands(files);
const commandActionsString = createCommandActionsString(projectCommands);

// 2. Create synthetic restoration message
filteredMessages = [
  {
    id: generateId(),
    role: 'user',
    content: 'Restore project from snapshot',
    annotations: ['no-store', 'hidden'] // Not saved or shown
  },
  {
    id: storedMessages.messages[snapshotIndex].id,
    role: 'assistant',
    content: `Bolt Restored your chat from a snapshot. You can revert this message to load the full chat history.
      <boltArtifact id="restored-project-setup" title="Restored Project & Setup" type="bundled">
        ${/* File actions for each file in snapshot */}
        <boltAction type="file" filePath="src/App.tsx">
          [file content]
        </boltAction>
        ${/* Shell commands for project setup */}
        ${commandActionsString}
      </boltArtifact>
    `,
    annotations: [
      'no-store', // Don't save this synthetic message
      { type: 'chatSummary', summary: '...' } // Optional summary
    ]
  },
  ...filteredMessages // Actual messages after snapshot
];
```

**Key Features:**
- **Banner text:** "Bolt Restored your chat from a snapshot..."
- **Bundled artifact:** All files in one `<boltArtifact>` tag
- **File actions:** Each file becomes `<boltAction type="file">`
- **Commands:** Auto-detected setup commands included
- **No-store annotation:** Won't be saved back to database
- **Revertable:** User can revert to see full history

---

#### File Restoration to WebContainer (Lines 364-367, 614-688)

**Trigger:**
```typescript
if (mixedId && !snapshotRestored) {
  await restoreSnapshot(mixedId, snapshot);
  snapshotRestored = true;
}
```

**The `restoreSnapshot()` Function:**

```typescript
async function restoreSnapshot(id: string, snapshot?: Snapshot) {
  const validSnapshot = snapshot || { chatIndex: '', files: {} };

  if (!validSnapshot?.files || Object.keys(validSnapshot.files).length === 0) {
    return; // No files to restore
  }

  // Helper: normalize paths (remove /home/project prefix)
  const stripWorkDirPrefix = (path: string): string => {
    if (path.startsWith(WORK_DIR + '/')) {
      return path.slice(WORK_DIR.length + 1);
    }
    return path;
  };

  const entries = Object.entries(validSnapshot.files);

  // STEP 1: Create folders (sorted by depth to ensure parents first)
  const folders = entries
    .filter(([, value]) => value?.type === 'folder')
    .sort(([a], [b]) => a.length - b.length);

  for (const [folderPath] of folders) {
    const normalizedPath = stripWorkDirPrefix(folderPath);
    if (!normalizedPath) continue;

    try {
      await workbenchStore.createFolder(normalizedPath);
    } catch {
      // Folder might already exist, ignore
    }
  }

  // STEP 2: Create files
  const files = entries.filter(([, value]) => value?.type === 'file');

  for (const [filePath, value] of files) {
    if (value?.type === 'file') {
      const normalizedPath = stripWorkDirPrefix(filePath);
      if (!normalizedPath) continue;

      try {
        await workbenchStore.createFile(normalizedPath, value.content);
      } catch (error) {
        logger.error('Failed to create file', { filePath, error });
      }
    }
  }

  logger.info('Snapshot restoration complete', {
    foldersCreated: folders.length,
    filesCreated: files.length
  });

  // Show workbench if files were restored
  if (files.length > 0) {
    workbenchStore.setShowWorkbench(true);
  }
}
```

**Restoration Flow:**
1. **Validate snapshot** - ensure files exist
2. **Normalize paths** - remove `/home/project` prefix
3. **Create folders first** - sorted by depth (parents before children)
4. **Create files second** - write to WebContainer via `workbenchStore.createFile()`
5. **Show workbench** - make editor visible if files were restored

**Result:**
- All files written to WebContainer virtual filesystem
- Nanostores (`filesStore`) updated reactively
- Editor displays files immediately
- File tree shows complete structure
- Preview can start dev server

---

#### Alternative Snapshot Scenarios

**Scenario 1: Snapshot without chatIndex match (Lines 374-386)**

```typescript
// If snapshot has files but chatIndex not found in messages
if (snapshot?.files && Object.keys(snapshot.files).length > 0
    && startingIdx <= 0 && !snapshotRestored) {

  logger.info('Restoring snapshot without chatIndex match', {
    filesCount: Object.keys(snapshot.files).length
  });

  await restoreSnapshot(idToRestore, snapshot);
  snapshotRestored = true;
}
```

**Use Case:** Snapshot exists but message history doesn't include the snapshot point

---

**Scenario 2: Project with no messages but has snapshot (Lines 403-416)**

```typescript
// New project or local chat without messages
if (projectId || mixedId) {
  setInitialMessages([]); // Empty chat
  chatId.set(mixedId || projectId);

  // Still restore files from snapshot
  if (snapshot?.files && Object.keys(snapshot.files).length > 0) {
    logger.info('Restoring snapshot for project with no messages');
    await restoreSnapshot(idToRestore, snapshot);
  }
}
```

**Use Case:** Newly generated projects, projects created via API, or generation failures

---

### Loading Older Messages (Pagination)

**Implementation:** `loadOlderMessages()` function (Lines 705-771)

**Triggers:**
- User scrolls to top of chat
- Clicks "Load older messages" button
- Shown when `hasOlderMessages === true`

**Process:**

```typescript
async function loadOlderMessages() {
  // Guardrails
  if (!projectId || !isUserAuthenticated()) return;
  if (loadingOlder) return; // Prevent duplicate requests

  // Check pagination limit (max 20 pages = 1000 messages)
  const currentPages = Math.ceil(loadedServerMessages / MESSAGE_PAGE_SIZE);
  if (currentPages >= MAX_MESSAGE_PAGES) {
    toast.info('Maximum messages loaded (1000)');
    return;
  }

  const offset = loadedServerMessages; // Load from where we left off

  setLoadingOlder(true);

  try {
    const { messages, total } = await getServerMessagesPage(
      projectId,
      offset,
      MESSAGE_PAGE_SIZE
    );

    if (messages.length === 0) {
      setTotalServerMessages(total);
      return; // No more messages
    }

    // Sort and prepend to existing messages
    const normalizedMessages = sortMessagesBySequence(messages);
    setInitialMessages(prev => [...normalizedMessages, ...prev]);
    setLoadedServerMessages(prev => prev + normalizedMessages.length);
    setTotalServerMessages(total);

    // Persist to IndexedDB for offline access
    if (db) {
      const allMessages = [...archivedMessages, ...normalizedMessages, ...initialMessages];
      await setMessages(db, persistedId, allMessages, ...);
    }

  } catch (error) {
    setLoadingOlderError(error.message);
    throw error;
  } finally {
    setLoadingOlder(false);
  }
}
```

**Key Features:**
- **Pagination:** Loads 50 messages at a time
- **Limit:** Max 1000 messages (performance constraint)
- **Prepends:** New messages added to beginning of array
- **Persists:** Updates IndexedDB with expanded history
- **Progress:** Shows loading spinner while fetching

**UI Indicators:**
- `hasOlderMessages`: `totalServerMessages > loadedServerMessages`
- `loadingOlder`: Shows spinner
- `loadingOlderError`: Shows error message with retry option

---

### Loading States and Progress Tracking

**State Type:** `MessageLoadingState` (from `~/types/message-loading.ts`)

```typescript
interface MessageLoadingState {
  phase: 'idle' | 'server' | 'local' | 'partial' | 'complete' | 'error';
  loaded: number;        // Messages loaded so far
  total: number | null;  // Total messages (if known)
  error: string | null;  // Error message
  isPartial: boolean;    // Partial load (rate limited, offline)
  retryCount: number;    // Failed retry attempts
  lastRetryAt: string | null; // Timestamp of last retry
}
```

**Phase Transitions:**

```
idle → server → complete  (successful server load)
idle → server → error     (server failure)
idle → server → local → complete  (fallback to IndexedDB)
idle → server → partial → complete (rate limited pagination)
```

**Progress Callback (Lines 127-147):**

```typescript
const onProgress = (progress: MessageLoadProgress) => {
  logger.info('Loading messages progress:', {
    loaded: progress.loaded,
    total: progress.total,
    page: progress.page,
    isComplete: progress.isComplete,
    isRateLimited: progress.isRateLimited
  });

  setLoadedServerMessages(progress.loaded);
  setTotalServerMessages(progress.total);

  setLoadingState(prev => ({
    ...prev,
    phase: progress.isRateLimited ? 'partial' : 'server',
    loaded: progress.loaded,
    total: progress.total,
    isPartial: !progress.isComplete && progress.loaded > 0
  }));
};
```

**UI Displays:**
- **"Loading from server..."** - `phase === 'server'`
- **"Loaded X of Y messages"** - Shows progress bar
- **"Loaded from local cache"** - `phase === 'local'` with warning
- **"Partial load (rate limited)"** - `isPartial === true`
- **"Failed to load"** - `phase === 'error'` with retry button

---

### Data Staleness Prevention

**Problem:** User navigates from Chat A → Chat B → Chat A rapidly

**Solution:** Track which ID the current data belongs to

```typescript
// Track which chat this data is for
const loadedIdRef = useRef<string | undefined>(undefined);

// Reset immediately when starting new load
loadedIdRef.current = undefined; // Invalidate

// ... load data ...

// Mark which ID this data belongs to
loadedIdRef.current = mixedId || projectId;

// Only show UI when data matches current chat
const currentId = mixedId || projectId;
const isDataForCurrentId = loadedIdRef.current === currentId;

return {
  ready: ready && isDataForCurrentId,
  initialMessages,
  // ...
};
```

**Result:** UI only renders when data matches the current route

---

### Complete Load Timeline

```
T+0ms:   User clicks chat link
T+50ms:  useChatHistory initializes, state reset
T+100ms: Loading state → 'server'
T+150ms: API request sent (GET /api/projects/:id/messages/recent)
T+200ms: API request sent (GET /api/projects/:id/snapshot)
T+500ms: Messages received (50 messages, page 1)
T+550ms: Snapshot received (FileMap with 20 files)
T+600ms: Messages sorted by sequence_num
T+650ms: Snapshot index found (message #35)
T+700ms: Archived messages: 0-35, Displayed messages: 36-50
T+750ms: Synthetic restoration message created
T+800ms: restoreSnapshot() begins
T+850ms: 5 folders created in WebContainer
T+900ms: 20 files written to WebContainer
T+950ms: Nanostores updated, UI reactive update
T+1000ms: Editor displays files, file tree renders
T+1050ms: Workbench shown, preview iframe initialized
T+1100ms: Loading state → 'complete'
T+1150ms: "Bolt Restored your chat from a snapshot" banner visible
T+1200ms: User can interact with chat and files
```

**Performance Targets:**
- Initial load: <1.5s (server-side)
- Snapshot restoration: <500ms (20 files)
- Older messages load: <800ms (pagination)

---

### Error Handling

**Server Load Failure:**
```typescript
catch (error) {
  logger.warn('Server load failed, falling back to IndexedDB');
  setLoadingState({ phase: 'local', isPartial: true });

  // Try IndexedDB
  const [clientMessages, clientSnapshot] = await Promise.all([
    getMessages(db, mixedId),
    getSnapshot(db, mixedId)
  ]);

  toast.warning('Loaded from local cache - server unavailable');
}
```

**IndexedDB Failure:**
```typescript
catch (localError) {
  logger.error('Failed to load from client storage');
  setLoadingState({
    phase: 'error',
    error: String(localError)
  });
  toast.error('Failed to load chat: ' + localError.message);
}
```

**Snapshot Restoration Failure:**
```typescript
catch (error) {
  logger.error('Failed to create file from snapshot', { filePath, error });
  // Continue with other files (partial restoration)
}
```

---

### Best Practices for Loading

1. **Always check authentication before server requests**
   ```typescript
   if (projectId && isUserAuthenticated()) {
     await getServerMessages(projectId);
   }
   ```

2. **Sort messages by sequence_num immediately after loading**
   ```typescript
   const sortedMessages = sortMessagesBySequence(serverMessages);
   ```

3. **Track snapshot restoration to prevent duplicates**
   ```typescript
   let snapshotRestored = false;
   if (!snapshotRestored) {
     await restoreSnapshot(id, snapshot);
     snapshotRestored = true;
   }
   ```

4. **Provide loading feedback to users**
   ```typescript
   setLoadingState({ phase: 'server', loaded: 0, total: null });
   // Update during pagination
   onProgress(progress);
   ```

5. **Validate data belongs to current chat**
   ```typescript
   const isDataForCurrentId = loadedIdRef.current === currentId;
   return { ready: ready && isDataForCurrentId };
   ```

---

## Synchronization Strategies

### Priority Order

```
┌─────────────────────────────────────┐
│  1. Server (Authenticated Users)    │  ← Source of truth
├─────────────────────────────────────┤
│  2. IndexedDB (Fallback)            │  ← Offline/unauthenticated
├─────────────────────────────────────┤
│  3. WebContainer (Session Only)     │  ← Lost on refresh
└─────────────────────────────────────┘
```

### Fallback Logic

```typescript
async function loadProject(projectId: string) {
  let messages: Message[] = [];
  let snapshot: Snapshot | null = null;

  // Try server first (if authenticated)
  if (projectId && isUserAuthenticated()) {
    try {
      [messages, snapshot] = await Promise.all([
        getServerMessages(projectId),
        getServerSnapshot(projectId)
      ]);

      console.log('Loaded from server');
      return { messages, snapshot };

    } catch (error) {
      console.warn('Server load failed, falling back to IndexedDB', error);
    }
  }

  // Fallback to IndexedDB
  if (db && chatId) {
    [messages, snapshot] = await Promise.all([
      getMessages(db, chatId),
      getSnapshot(db, chatId)
    ]);

    console.log('Loaded from IndexedDB');
    return { messages, snapshot };
  }

  // No data available
  console.log('Starting fresh project');
  return { messages: [], snapshot: null };
}
```

### Conflict Resolution

**Messages:**
- Server allocates `sequence_num` for ordering
- Client-generated `message_id` ensures uniqueness
- Server uses `ON CONFLICT DO NOTHING` - never overwrites

**Snapshots:**
- One snapshot per project (UNIQUE constraint)
- Last write wins (UPSERT behavior)
- `updated_at` timestamp tracks latest version

**Files:**
- WebContainer is source during active session
- Snapshot captures state at specific message
- No automatic merging - full restore or current state

---

## Data Flow Examples

### Example 1: New Project with AI Generation

```
1. User creates project "My Restaurant"
   POST /api/projects
   { name: "My Restaurant" }
   ↓
   Server creates project record
   Returns: { id: 'proj-123', url_id: 'my-restaurant-xyz' }

2. User sends message: "Create a restaurant homepage"
   ↓
   Chat.client.tsx: append({ role: 'user', content })
   ↓
   POST /api/chat (SSE streaming)
   ↓
   LLM generates response with file actions:

   <boltArtifact id="homepage" title="Restaurant Homepage">
     <boltAction type="file" filePath="src/App.tsx">
       import React from 'react';
       ...
     </boltAction>
     <boltAction type="file" filePath="package.json">
       { "name": "restaurant-site" }
     </boltAction>
   </boltArtifact>

3. Actions execute
   ↓
   ActionRunner writes files to WebContainer
   ↓
   File watcher updates Nanostores
   ↓
   Editor displays files

4. Stream completes
   ↓
   storeMessageHistory() called
   ↓
   Messages saved:
   ├─→ IndexedDB: setMessages()
   └─→ Server: POST /api/projects/proj-123/messages/append

   Snapshot created:
   ├─→ IndexedDB: setSnapshot()
   └─→ Server: PUT /api/projects/proj-123/snapshot

5. Result
   ✓ Chat history saved
   ✓ All files saved
   ✓ Project state captured
   ✓ Can restore from any device
```

---

### Example 2: Loading Existing Project

```
1. User navigates to /chat/my-restaurant-xyz
   ↓
   Loader function runs:
   - Resolves url_id → project_id
   - Validates user ownership

2. Chat.client.tsx mounts
   ↓
   useChatHistory hook initializes
   ↓
   Loads data in parallel:

   Promise.all([
     getServerMessages(projectId),      // GET /api/projects/:id/messages/recent
     getServerSnapshot(projectId)       // GET /api/projects/:id/snapshot
   ])

3. Messages received
   ↓
   [
     { id: 'msg-1', role: 'user', content: 'Create homepage' },
     { id: 'msg-2', role: 'assistant', content: '<boltArtifact>...' }
   ]

4. Snapshot received
   ↓
   {
     chatIndex: 'msg-2',
     files: {
       'src/App.tsx': { type: 'file', content: '...' },
       'package.json': { type: 'file', content: '...' }
     }
   }

5. Restoration process
   ↓
   Create bundled artifact message from snapshot
   ↓
   Insert at beginning: [snapshotMessage, ...originalMessages]
   ↓
   ActionRunner executes file actions
   ↓
   Files written to WebContainer
   ↓
   Nanostores updated
   ↓
   Editor displays files

6. UI shows
   ✓ Full conversation history
   ✓ All files in editor/file tree
   ✓ Preview renders website
   ✓ "Restored from snapshot" banner
```

---

### Example 3: Offline Editing

```
1. User loses internet connection
   ↓
   Chat continues to work
   ↓
   useChat hook streams from /api/chat
   ↓
   (API call fails)

2. Error handling
   ↓
   Toast notification: "Connection lost"
   ↓
   Messages queued in memory
   ↓
   Files still editable (WebContainer is local)

3. User continues editing
   ↓
   Editor saves to WebContainer
   ↓
   Nanostores updated
   ↓
   UI reflects changes

4. Periodic save attempt
   ↓
   storeMessageHistory() runs
   ↓
   IndexedDB save: ✓ SUCCESS
   ↓
   Server save: ✗ FAILED (offline)
   ↓
   Messages marked as 'pending-sync'
   ↓
   syncStatusStore updated

5. UI shows sync indicator
   ⚠️ "3 messages pending sync"

6. Connection restored
   ↓
   Background sync triggered (2s delay)
   ↓
   checkAndSyncPending() runs
   ↓
   POST /api/projects/:id/messages/append
   ↓
   Success: pending messages saved
   ↓
   Clear 'pending-sync' annotations
   ↓
   Toast: "✓ Synced 3 messages"

7. Result
   ✓ No data lost
   ✓ Seamless offline experience
   ✓ Auto-sync on reconnect
```

---

## API Endpoints Reference

### Projects

| Method | Endpoint | Purpose | Request | Response |
|--------|----------|---------|---------|----------|
| GET | `/api/projects` | List user's projects | - | `Project[]` |
| POST | `/api/projects` | Create new project | `{ name, description?, google_maps_url? }` | `Project` |
| GET | `/api/projects/:id` | Get project details | - | `Project` |
| PATCH | `/api/projects/:id` | Update project | `{ name?, description?, status? }` | `Project` |
| DELETE | `/api/projects/:id` | Delete project (cascades) | - | `{ success: true }` |

### Messages

| Method | Endpoint | Purpose | Request | Response |
|--------|----------|---------|---------|----------|
| POST | `/api/projects/:id/messages/append` | Batch save messages | `{ messages: Message[] }` | `{ count: number }` |
| GET | `/api/projects/:id/messages/recent` | Load recent messages | `?limit=50` | `{ messages: Message[] }` |
| GET | `/api/projects/:id/messages` | Paginated messages | `?page=1&limit=50` | `{ messages: Message[], hasMore: boolean }` |

### Snapshots

| Method | Endpoint | Purpose | Request | Response |
|--------|----------|---------|---------|----------|
| PUT | `/api/projects/:id/snapshot` | Save/update snapshot | `{ files: FileMap, summary?: string }` | `{ updated_at: string }` |
| GET | `/api/projects/:id/snapshot` | Load snapshot | - | `{ files: FileMap, summary, created_at, updated_at }` |

### Chat Streaming

| Method | Endpoint | Purpose | Request | Response |
|--------|----------|---------|---------|----------|
| POST | `/api/chat` | Stream AI response | `{ messages: Message[] }` | SSE stream with data chunks |

---

## Size Limits & Constraints

| Resource | Limit | Warning Threshold | Notes |
|----------|-------|-------------------|-------|
| Snapshot size | 50 MB | 45 MB | Enforced server-side |
| WebContainer memory | ~1 GB | - | For cloned templates |
| IndexedDB storage | Browser-dependent | - | Typically 50-500 MB per origin |
| Message batch size | 1000 messages | - | Pagination recommended |
| Cloudflare timeout | 30 seconds | - | Affects snapshot save latency |
| Token context | 190K tokens | 180K | Auto-truncates old messages |

---

## Performance Considerations

### Optimizations

1. **Message Batching**
   - 50ms sampler debounce prevents rapid saves
   - Batch multiple messages into single API call

2. **Snapshot Compression**
   - JSONB in PostgreSQL provides automatic compression
   - Client sanitizes files (removes undefined fields)

3. **Lazy Loading**
   - Messages paginated (50 per page)
   - Only load snapshots when needed

4. **Caching**
   - IndexedDB acts as local cache
   - Server queries optimized with indexes on `project_id`, `sequence_num`

5. **Concurrent Operations**
   - Messages and snapshots saved in parallel
   - File actions queued to prevent race conditions

### Monitoring

```typescript
// Track save performance
performance.mark('snapshot-save-start');
await setServerSnapshot(projectId, snapshot);
performance.mark('snapshot-save-end');
performance.measure('snapshot-save', 'snapshot-save-start', 'snapshot-save-end');

// Log metrics
const measure = performance.getEntriesByName('snapshot-save')[0];
console.log(`Snapshot saved in ${measure.duration}ms`);
```

---

## Error Handling

### Common Errors

**1. Authentication Required**
```typescript
if (!session) {
  return json({ error: 'Authentication required' }, { status: 401 });
}
```

**2. Project Not Found**
```typescript
if (!project) {
  return json({ error: 'Project not found' }, { status: 404 });
}
```

**3. Permission Denied (RLS)**
```typescript
// Automatically enforced by Row-Level Security
// User can only access their own projects
```

**4. Snapshot Too Large**
```typescript
const sizeInMB = JSON.stringify(files).length / (1024 * 1024);
if (sizeInMB > 50) {
  throw new Error('Snapshot exceeds 50MB limit');
}
```

**5. Network Failure**
```typescript
try {
  await appendServerMessages(projectId, messages);
} catch (error) {
  // Mark messages as pending
  messages.forEach(m => markMessageAsPending(projectId, m.id));

  // Show retry UI
  setSyncError(projectId, {
    message: 'Sync failed',
    retryable: true
  });
}
```

---

## Security Considerations

### Row-Level Security (RLS)

All database queries automatically enforce user isolation:

```sql
-- Example RLS policy
CREATE POLICY "Users can only access their own projects"
  ON projects
  FOR ALL
  USING (user_id = current_setting('app.current_user_id')::UUID);
```

### Authentication Flow

```typescript
// 1. Request enters API route
export async function loader({ request }: LoaderFunctionArgs) {

  // 2. Get session from Better Auth
  const session = await auth.api.getSession({
    headers: request.headers
  });

  if (!session?.user) {
    throw redirect('/auth/login');
  }

  // 3. Set RLS context for database queries
  const supabase = createSupabaseClient(session.user.id);

  // 4. All queries now automatically filtered by user_id
  const { data } = await supabase
    .from('projects')
    .select('*');  // Only returns current user's projects
}
```

### Data Validation

```typescript
// Zod schemas for API input validation
const MessageSchema = z.object({
  message_id: z.string().uuid(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([z.string(), z.array(z.any()), z.object({})]),
  annotations: z.array(z.any()).optional()
});

const SnapshotSchema = z.object({
  files: z.record(z.string(), z.any()),
  summary: z.string().max(1000).optional()
});
```

---

## Troubleshooting

### Messages Not Syncing

**Symptom:** "Pending sync" indicator persists

**Diagnosis:**
```typescript
// Check sync state
const status = computeSyncStatus(projectId);
console.log('Pending:', status.pendingCount);
console.log('Errors:', syncErrorsStore.get().get(projectId));
```

**Solutions:**
1. Check authentication: `isUserAuthenticated()`
2. Verify network connectivity
3. Check browser console for API errors
4. Try manual retry: Click "Retry Sync" button
5. Check message annotations for `'no-store'`

---

### Snapshot Not Restoring

**Symptom:** Empty file tree on project load

**Diagnosis:**
```typescript
// Check snapshot exists
const snapshot = await getServerSnapshot(projectId);
console.log('Snapshot found:', !!snapshot);
console.log('File count:', Object.keys(snapshot?.files || {}).length);
```

**Solutions:**
1. Verify snapshot was saved: Check Supabase `project_snapshots` table
2. Check file actions executed: Look for errors in action runner
3. Verify WebContainer initialized: `webcontainer !== null`
4. Check browser IndexedDB: DevTools → Application → IndexedDB → boltHistory

---

### Files Lost on Refresh

**Symptom:** Files disappear when reloading page

**Root Cause:** Files only in WebContainer (not saved to snapshot)

**Solutions:**
1. Ensure snapshot created after file generation
2. Check `storeMessageHistory()` was called
3. Verify `takeSnapshot()` completed successfully
4. Check network tab for snapshot save API call
5. Confirm IndexedDB has snapshot record

---

## Best Practices

### For Developers

1. **Always wait for actions to complete before snapshot**
   ```typescript
   await workbenchStore.waitForActionsToComplete();
   await workbenchStore.saveAllFiles();
   const files = workbenchStore.files.get();
   ```

2. **Use annotations for ephemeral messages**
   ```typescript
   append({
     role: 'assistant',
     content: 'Thinking...',
     annotations: ['no-store']  // Won't be saved
   });
   ```

3. **Handle offline gracefully**
   ```typescript
   try {
     await appendServerMessages(projectId, messages);
   } catch (error) {
     // Fall back to IndexedDB
     await setMessages(db, chatId, messages);
   }
   ```

4. **Monitor snapshot size**
   ```typescript
   const size = JSON.stringify(files).length / (1024 * 1024);
   if (size > 45) {
     console.warn(`Snapshot approaching limit: ${size.toFixed(2)}MB`);
   }
   ```

5. **Clean up on unmount**
   ```typescript
   useEffect(() => {
     return () => {
       // Flush pending saves
       storeMessageHistory();
     };
   }, []);
   ```

---

## Related Files

### Core Persistence
- `/app/lib/persistence/useChatHistory.ts` - Main persistence hook (1000+ lines)
- `/app/lib/persistence/db.ts` - IndexedDB operations
- `/app/lib/persistence/messageSyncState.ts` - Sync tracking
- `/app/lib/persistence/annotationHelpers.ts` - Annotation utilities

### File Management
- `/app/lib/stores/workbench.ts` - Workbench orchestration
- `/app/lib/stores/files.ts` - File map and modification tracking
- `/app/lib/stores/editor.ts` - Editor document state
- `/app/lib/webcontainer/index.ts` - WebContainer initialization

### API Routes
- `/app/routes/api.projects.ts` - Project CRUD
- `/app/routes/api.projects.$id.ts` - Project details
- `/app/routes/api.projects.$id.messages.append.ts` - Message batch save
- `/app/routes/api.projects.$id.messages.recent.ts` - Message loading
- `/app/routes/api.projects.$id.snapshot.ts` - Snapshot save/load
- `/app/routes/api.chat.ts` - LLM streaming

### Services
- `/app/lib/services/projects.server.ts` - Project business logic
- `/app/lib/runtime/action-runner.ts` - File action execution
- `/app/lib/runtime/message-parser.ts` - Parse LLM responses

### Components
- `/app/components/chat/Chat.client.tsx` - Main chat component
- `/app/components/workbench/Workbench.client.tsx` - Workbench UI
- `/app/components/editor/` - Code editor components

---

## Conclusion

The website-agent persistence architecture provides:

✅ **Reliability** - Triple-redundant storage (runtime + browser + server)
✅ **Offline Support** - IndexedDB enables full offline capability
✅ **Multi-Device Sync** - Server storage accessible from any device
✅ **Conflict-Free** - Server-allocated sequence numbers prevent conflicts
✅ **Complete State** - Snapshots capture entire project at any point
✅ **Fast Restore** - Instant project loading from cached snapshots
✅ **Automatic Sync** - Background sync when authentication restored
✅ **Data Integrity** - RLS policies enforce user isolation

This design ensures users never lose work, can collaborate across devices, and enjoy a seamless offline/online experience.
