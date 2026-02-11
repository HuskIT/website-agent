import type { PathWatcherEvent, WebContainer } from '@webcontainer/api';
import { getEncoding } from 'istextorbinary';
import { map, type MapStore } from 'nanostores';
import { Buffer } from 'node:buffer';
import { path } from '~/utils/path';
import { bufferWatchEvents } from '~/utils/buffer';
import { WORK_DIR } from '~/utils/constants';
import { computeFileModifications } from '~/utils/diff';
import { createScopedLogger } from '~/utils/logger';
import {
  addLockedFile,
  removeLockedFile,
  addLockedFolder,
  removeLockedFolder,
  getLockedItemsForChat,
  getLockedFilesForChat,
  getLockedFoldersForChat,
  isPathInLockedFolder,
  migrateLegacyLocks,
  clearCache,
} from '~/lib/persistence/lockedFiles';
import { getCurrentChatId } from '~/utils/fileLocks';
import type { FileSyncManager } from '~/lib/sandbox/file-sync';

const logger = createScopedLogger('FilesStore');

const utf8TextDecoder = new TextDecoder('utf8', { fatal: true });

/**
 * Validates and normalizes a file path to ensure it's within the WebContainer working directory.
 * Returns the relative path from the working directory.
 *
 * @param workdir - The WebContainer working directory (e.g., '/home/project')
 * @param filePath - The file path to validate (can be absolute or relative)
 * @returns The normalized relative path
 * @throws Error if the path escapes the working directory
 */
function validateAndNormalizePath(workdir: string, filePath: string): string {
  let normalizedPath = filePath;

  if (filePath.startsWith(workdir)) {
    // Already absolute within workdir - use as-is
    normalizedPath = filePath;
  } else if (filePath.startsWith('/')) {
    /*
     * Absolute path but not starting with workdir - treat as relative to workdir
     * Strip the leading slash and join with workdir
     */
    const pathWithoutSlash = filePath.slice(1);
    normalizedPath = path.join(workdir, pathWithoutSlash);
  } else {
    // Relative path - join with workdir
    normalizedPath = path.join(workdir, filePath);
  }

  const relativePath = path.relative(workdir, normalizedPath);

  // Reject paths that escape the working directory
  if (!relativePath || relativePath.startsWith('..') || relativePath === '.') {
    throw new Error(`EINVAL: invalid path, must be within ${workdir}, got '${filePath}'`);
  }

  return relativePath;
}

export interface File {
  type: 'file';
  content: string;
  isBinary: boolean;
  isLocked?: boolean;
  lockedByFolder?: string; // Path of the folder that locked this file
}

export interface Folder {
  type: 'folder';
  isLocked?: boolean;
  lockedByFolder?: string; // Path of the folder that locked this folder (for nested folders)
}

type Dirent = File | Folder;

export type FileMap = Record<string, Dirent | undefined>;

export class FilesStore {
  #webcontainer: Promise<WebContainer>;

  /**
   * Tracks the number of files without folders.
   */
  #size = 0;

  /**
   * @note Keeps track all modified files with their original content since the last user message.
   * Needs to be reset when the user sends another message and all changes have to be submitted
   * for the model to be aware of the changes.
   */
  #modifiedFiles: Map<string, string> = import.meta.hot?.data.modifiedFiles ?? new Map();

  /**
   * Keeps track of deleted files and folders to prevent them from reappearing on reload
   */
  #deletedPaths: Set<string> = import.meta.hot?.data.deletedPaths ?? new Set();

  /**
   * Tracks files that were recently saved programmatically to prevent the file watcher
   * from overwriting them with stale or empty content during WebContainer's write operation.
   */
  #recentlySavedFiles: Set<string> = new Set();

  /**
   * FileSyncManager for syncing file changes to cloud sandbox provider.
   * When set, file operations will also sync through this manager.
   */
  #fileSyncManager: FileSyncManager | null = null;

  /**
   * Map of files that matches the state of WebContainer.
   */
  files: MapStore<FileMap> = import.meta.hot?.data.files ?? map({});

  get filesCount() {
    return this.#size;
  }

  constructor(webcontainerPromise: Promise<WebContainer>) {
    this.#webcontainer = webcontainerPromise;

    // Load deleted paths from localStorage if available
    try {
      if (typeof localStorage !== 'undefined') {
        const deletedPathsJson = localStorage.getItem('bolt-deleted-paths');

        if (deletedPathsJson) {
          const deletedPaths = JSON.parse(deletedPathsJson);

          if (Array.isArray(deletedPaths)) {
            deletedPaths.forEach((path) => this.#deletedPaths.add(path));
          }
        }
      }
    } catch (error) {
      logger.error('Failed to load deleted paths from localStorage', error);
    }

    // Load locked files from localStorage
    this.#loadLockedFiles();

    if (import.meta.hot) {
      // Persist our state across hot reloads
      import.meta.hot.data.files = this.files;
      import.meta.hot.data.modifiedFiles = this.#modifiedFiles;
      import.meta.hot.data.deletedPaths = this.#deletedPaths;
    }

    // Listen for URL changes to detect chat ID changes
    if (typeof window !== 'undefined') {
      let lastChatId = getCurrentChatId();

      // Use MutationObserver to detect URL changes (for SPA navigation)
      const observer = new MutationObserver(() => {
        const currentChatId = getCurrentChatId();

        if (currentChatId !== lastChatId) {
          logger.info(`Chat ID changed from ${lastChatId} to ${currentChatId}, reloading locks`);
          lastChatId = currentChatId;
          this.#loadLockedFiles(currentChatId);
        }
      });

      observer.observe(document, { subtree: true, childList: true });
    }

    this.#init();
  }

  /**
   * Pending writes that were requested before FileSyncManager was ready.
   * Maps relative path to content.
   */
  #pendingSyncs: Map<string, string> = new Map();
  #instanceId = Math.random().toString(36).substring(7);

  /**
   * Set the FileSyncManager for syncing file changes to cloud sandbox provider.
   * When set, file save operations will also sync through this manager.
   * @param manager The FileSyncManager instance or null to disable syncing
   */
  setFileSyncManager(manager: FileSyncManager | null): void {
    logger.info(`[FilesStore:${this.#instanceId}] setFileSyncManager`, {
      managerExists: !!manager,
      pendingCount: this.#pendingSyncs.size,
    });

    this.#fileSyncManager = manager;

    if (manager) {
      // Flush pending syncs
      if (this.#pendingSyncs.size > 0) {
        logger.info(`[FilesStore:${this.#instanceId}] Flushing ${this.#pendingSyncs.size} pending file syncs`);

        for (const [path, content] of this.#pendingSyncs.entries()) {
          manager.queueWrite(path, content);
        }

        this.#pendingSyncs.clear();
      }
    } else {
      // If manager is removed, clear pending syncs to avoid stale data
      this.#pendingSyncs.clear();
    }

    logger.info('FileSyncManager', manager ? 'connected' : 'disconnected');
  }

  /**
   * Get the current FileSyncManager instance.
   * @returns The current FileSyncManager or null if not set
   */
  getFileSyncManager(): FileSyncManager | null {
    return this.#fileSyncManager;
  }

  /**
   * Load locked files and folders from localStorage and update the file objects
   * @param chatId Optional chat ID to load locks for (defaults to current chat)
   */
  #loadLockedFiles(chatId?: string) {
    try {
      const currentChatId = chatId || getCurrentChatId();
      const startTime = performance.now();

      // Migrate any legacy locks to the current chat
      migrateLegacyLocks(currentChatId);

      // Get all locked items for this chat (uses optimized cache)
      const lockedItems = getLockedItemsForChat(currentChatId);

      // Split into files and folders
      const lockedFiles = lockedItems.filter((item) => !item.isFolder);
      const lockedFolders = lockedItems.filter((item) => item.isFolder);

      if (lockedItems.length === 0) {
        logger.info(`No locked items found for chat ID: ${currentChatId}`);
        return;
      }

      logger.info(
        `Found ${lockedFiles.length} locked files and ${lockedFolders.length} locked folders for chat ID: ${currentChatId}`,
      );

      const currentFiles = this.files.get();
      const updates: FileMap = {};

      // Process file locks
      for (const lockedFile of lockedFiles) {
        const file = currentFiles[lockedFile.path];

        if (file?.type === 'file') {
          updates[lockedFile.path] = {
            ...file,
            isLocked: true,
          };
        }
      }

      // Process folder locks
      for (const lockedFolder of lockedFolders) {
        const folder = currentFiles[lockedFolder.path];

        if (folder?.type === 'folder') {
          updates[lockedFolder.path] = {
            ...folder,
            isLocked: true,
          };

          // Also mark all files within the folder as locked
          this.#applyLockToFolderContents(currentFiles, updates, lockedFolder.path);
        }
      }

      if (Object.keys(updates).length > 0) {
        this.files.set({ ...currentFiles, ...updates });
      }

      const endTime = performance.now();
      logger.info(`Loaded locked items in ${Math.round(endTime - startTime)}ms`);
    } catch (error) {
      logger.error('Failed to load locked files from localStorage', error);
    }
  }

  /**
   * Apply a lock to all files within a folder
   * @param currentFiles Current file map
   * @param updates Updates to apply
   * @param folderPath Path of the folder to lock
   */
  #applyLockToFolderContents(currentFiles: FileMap, updates: FileMap, folderPath: string) {
    const folderPrefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

    // Find all files that are within this folder
    Object.entries(currentFiles).forEach(([path, file]) => {
      if (path.startsWith(folderPrefix) && file) {
        if (file.type === 'file') {
          updates[path] = {
            ...file,
            isLocked: true,

            // Add a property to indicate this is locked by a parent folder
            lockedByFolder: folderPath,
          };
        } else if (file.type === 'folder') {
          updates[path] = {
            ...file,
            isLocked: true,

            // Add a property to indicate this is locked by a parent folder
            lockedByFolder: folderPath,
          };
        }
      }
    });
  }

  /**
   * Lock a file
   * @param filePath Path to the file to lock
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns True if the file was successfully locked
   */
  lockFile(filePath: string, chatId?: string) {
    const file = this.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      logger.error(`Cannot lock non-existent file: ${filePath}`);
      return false;
    }

    // Update the file in the store
    this.files.setKey(filePath, {
      ...file,
      isLocked: true,
    });

    // Persist to localStorage with chat ID
    addLockedFile(currentChatId, filePath);

    logger.info(`File locked: ${filePath} for chat: ${currentChatId}`);

    return true;
  }

  /**
   * Lock a folder and all its contents
   * @param folderPath Path to the folder to lock
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns True if the folder was successfully locked
   */
  lockFolder(folderPath: string, chatId?: string) {
    const folder = this.getFileOrFolder(folderPath);
    const currentFiles = this.files.get();
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      logger.error(`Cannot lock non-existent folder: ${folderPath}`);
      return false;
    }

    const updates: FileMap = {};

    // Update the folder in the store
    updates[folderPath] = {
      type: folder.type,
      isLocked: true,
    };

    // Apply lock to all files within the folder
    this.#applyLockToFolderContents(currentFiles, updates, folderPath);

    // Update the store with all changes
    this.files.set({ ...currentFiles, ...updates });

    // Persist to localStorage with chat ID
    addLockedFolder(currentChatId, folderPath);

    logger.info(`Folder locked: ${folderPath} for chat: ${currentChatId}`);

    return true;
  }

  /**
   * Unlock a file
   * @param filePath Path to the file to unlock
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns True if the file was successfully unlocked
   */
  unlockFile(filePath: string, chatId?: string) {
    const file = this.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      logger.error(`Cannot unlock non-existent file: ${filePath}`);
      return false;
    }

    // Update the file in the store
    this.files.setKey(filePath, {
      ...file,
      isLocked: false,
      lockedByFolder: undefined, // Clear the parent folder lock reference if it exists
    });

    // Remove from localStorage with chat ID
    removeLockedFile(currentChatId, filePath);

    logger.info(`File unlocked: ${filePath} for chat: ${currentChatId}`);

    return true;
  }

  /**
   * Unlock a folder and all its contents
   * @param folderPath Path to the folder to unlock
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns True if the folder was successfully unlocked
   */
  unlockFolder(folderPath: string, chatId?: string) {
    const folder = this.getFileOrFolder(folderPath);
    const currentFiles = this.files.get();
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      logger.error(`Cannot unlock non-existent folder: ${folderPath}`);
      return false;
    }

    const updates: FileMap = {};

    // Update the folder in the store
    updates[folderPath] = {
      type: folder.type,
      isLocked: false,
    };

    // Find all files that are within this folder and unlock them
    const folderPrefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

    Object.entries(currentFiles).forEach(([path, file]) => {
      if (path.startsWith(folderPrefix) && file) {
        if (file.type === 'file' && file.lockedByFolder === folderPath) {
          updates[path] = {
            ...file,
            isLocked: false,
            lockedByFolder: undefined,
          };
        } else if (file.type === 'folder' && file.lockedByFolder === folderPath) {
          updates[path] = {
            type: file.type,
            isLocked: false,
            lockedByFolder: undefined,
          };
        }
      }
    });

    // Update the store with all changes
    this.files.set({ ...currentFiles, ...updates });

    // Remove from localStorage with chat ID
    removeLockedFolder(currentChatId, folderPath);

    logger.info(`Folder unlocked: ${folderPath} for chat: ${currentChatId}`);

    return true;
  }

  /**
   * Check if a file is locked
   * @param filePath Path to the file to check
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns Object with locked status, lock mode, and what caused the lock
   */
  isFileLocked(filePath: string, chatId?: string): { locked: boolean; lockedBy?: string } {
    const file = this.getFile(filePath);
    const currentChatId = chatId || getCurrentChatId();

    if (!file) {
      return { locked: false };
    }

    // First check the in-memory state
    if (file.isLocked) {
      // If the file is locked by a folder, include that information
      if (file.lockedByFolder) {
        return {
          locked: true,
          lockedBy: file.lockedByFolder as string,
        };
      }

      return {
        locked: true,
        lockedBy: filePath,
      };
    }

    // Then check localStorage for direct file locks
    const lockedFiles = getLockedFilesForChat(currentChatId);
    const lockedFile = lockedFiles.find((item) => item.path === filePath);

    if (lockedFile) {
      // Update the in-memory state to match localStorage
      this.files.setKey(filePath, {
        ...file,
        isLocked: true,
      });

      return { locked: true, lockedBy: filePath };
    }

    // Finally, check if the file is in a locked folder
    const folderLockResult = this.isFileInLockedFolder(filePath, currentChatId);

    if (folderLockResult.locked) {
      // Update the in-memory state to reflect the folder lock
      this.files.setKey(filePath, {
        ...file,
        isLocked: true,
        lockedByFolder: folderLockResult.lockedBy,
      });

      return folderLockResult;
    }

    return { locked: false };
  }

  /**
   * Check if a file is within a locked folder
   * @param filePath Path to the file to check
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns Object with locked status, lock mode, and the folder that caused the lock
   */
  isFileInLockedFolder(filePath: string, chatId?: string): { locked: boolean; lockedBy?: string } {
    const currentChatId = chatId || getCurrentChatId();

    // Use the optimized function from lockedFiles.ts
    return isPathInLockedFolder(currentChatId, filePath);
  }

  /**
   * Check if a folder is locked
   * @param folderPath Path to the folder to check
   * @param chatId Optional chat ID (defaults to current chat)
   * @returns Object with locked status and lock mode
   */
  isFolderLocked(folderPath: string, chatId?: string): { isLocked: boolean; lockedBy?: string } {
    const folder = this.getFileOrFolder(folderPath);
    const currentChatId = chatId || getCurrentChatId();

    if (!folder || folder.type !== 'folder') {
      return { isLocked: false };
    }

    // First check the in-memory state
    if (folder.isLocked) {
      return {
        isLocked: true,
        lockedBy: folderPath,
      };
    }

    // Then check localStorage for this specific chat
    const lockedFolders = getLockedFoldersForChat(currentChatId);
    const lockedFolder = lockedFolders.find((item) => item.path === folderPath);

    if (lockedFolder) {
      // Update the in-memory state to match localStorage
      this.files.setKey(folderPath, {
        type: folder.type,
        isLocked: true,
      });

      return { isLocked: true, lockedBy: folderPath };
    }

    return { isLocked: false };
  }

  getFile(filePath: string) {
    const dirent = this.files.get()[filePath];

    if (!dirent) {
      return undefined;
    }

    // For backward compatibility, only return file type dirents
    if (dirent.type !== 'file') {
      return undefined;
    }

    return dirent;
  }

  /**
   * Get any file or folder from the file system
   * @param path Path to the file or folder
   * @returns The file or folder, or undefined if it doesn't exist
   */
  getFileOrFolder(path: string) {
    return this.files.get()[path];
  }

  getFileModifications() {
    return computeFileModifications(this.files.get(), this.#modifiedFiles);
  }
  getModifiedFiles() {
    let modifiedFiles: { [path: string]: File } | undefined = undefined;

    for (const [filePath, originalContent] of this.#modifiedFiles) {
      const file = this.files.get()[filePath];

      if (file?.type !== 'file') {
        continue;
      }

      if (file.content === originalContent) {
        continue;
      }

      if (!modifiedFiles) {
        modifiedFiles = {};
      }

      modifiedFiles[filePath] = file;
    }

    return modifiedFiles;
  }

  resetFileModifications() {
    this.#modifiedFiles.clear();
  }

  /**
   * Get the paths of all files that have been modified in the current session.
   * Used for context selection to boost recently edited files.
   * @returns Array of absolute file paths that have been modified
   */
  getModifiedFilePaths(): string[] {
    return Array.from(this.#modifiedFiles.keys());
  }

  /**
   * Mark a file as recently saved to prevent the file watcher from overwriting
   * it with stale content. This is useful when writing files directly to WebContainer
   * without going through saveFile().
   *
   * @param relativePath - The relative path of the file (from WebContainer workdir)
   * @param timeout - How long to protect the file from watcher updates (default: 1000ms)
   */
  markRecentlySaved(relativePath: string, timeout: number = 1000) {
    this.#recentlySavedFiles.add(relativePath);
    setTimeout(() => this.#recentlySavedFiles.delete(relativePath), timeout);
    logger.debug('Marked file as recently saved', { relativePath, timeout });
  }

  async #init() {
    const webcontainer = await this.#webcontainer;

    // Clean up any files that were previously deleted
    this.#cleanupDeletedFiles();

    // Set up file watcher
    webcontainer.internal.watchPaths(
      {
        include: [`${WORK_DIR}/**`],
        exclude: ['**/node_modules', '.git', '**/package-lock.json'],
        includeContent: true,
      },
      bufferWatchEvents(100, this.#processEventBuffer.bind(this)),
    );

    // Get the current chat ID
    const currentChatId = getCurrentChatId();

    // Migrate any legacy locks to the current chat
    migrateLegacyLocks(currentChatId);

    // Load locked files immediately for the current chat
    this.#loadLockedFiles(currentChatId);

    /**
     * Also set up a timer to load locked files again after a delay.
     * This ensures that locks are applied even if files are loaded asynchronously.
     */
    setTimeout(() => {
      this.#loadLockedFiles(currentChatId);
    }, 2000);

    /**
     * Set up a less frequent periodic check to ensure locks remain applied.
     * This is now less critical since we have the storage event listener.
     */
    setInterval(() => {
      // Clear the cache to force a fresh read from localStorage
      clearCache();

      const latestChatId = getCurrentChatId();
      this.#loadLockedFiles(latestChatId);
    }, 30000); // Reduced from 10s to 30s
  }

  /**
   * Removes any deleted files/folders from the store
   */
  #cleanupDeletedFiles() {
    if (this.#deletedPaths.size === 0) {
      return;
    }

    const currentFiles = this.files.get();
    const pathsToDelete = new Set<string>();

    // Precompute prefixes for efficient checking
    const deletedPrefixes = [...this.#deletedPaths].map((p) => p + '/');

    // Iterate through all current files/folders once
    for (const [path, dirent] of Object.entries(currentFiles)) {
      // Skip if dirent is already undefined (shouldn't happen often but good practice)
      if (!dirent) {
        continue;
      }

      // Check for exact match in deleted paths
      if (this.#deletedPaths.has(path)) {
        pathsToDelete.add(path);
        continue; // No need to check prefixes if it's an exact match
      }

      // Check if the path starts with any of the deleted folder prefixes
      for (const prefix of deletedPrefixes) {
        if (path.startsWith(prefix)) {
          pathsToDelete.add(path);
          break; // Found a match, no need to check other prefixes for this path
        }
      }
    }

    // Perform the deletions and updates based on the collected paths
    if (pathsToDelete.size > 0) {
      const updates: FileMap = {};

      for (const pathToDelete of pathsToDelete) {
        const dirent = currentFiles[pathToDelete];
        updates[pathToDelete] = undefined; // Mark for deletion in the map update

        if (dirent?.type === 'file') {
          this.#size--;

          if (this.#modifiedFiles.has(pathToDelete)) {
            this.#modifiedFiles.delete(pathToDelete);
          }
        }
      }

      // Apply all deletions to the store at once for potential efficiency
      this.files.set({ ...currentFiles, ...updates });
    }
  }

  #processEventBuffer(events: Array<[events: PathWatcherEvent[]]>) {
    // Start timing
    console.time('FilesStore:processEventBuffer');

    const watchEvents = events.flat(2);

    // Log count
    logger.debug(`Processing ${watchEvents.length} file system events`);

    const currentFiles = this.files.get();
    const updates: FileMap = {};
    let hasChanges = false;

    // Track size delta for this batch
    let sizeDelta = 0;

    for (const { type, path, buffer } of watchEvents) {
      // Remove trailing slashes and normalize to relative path
      let sanitizedPath = path.replace(/\/+$/g, '');

      // Strip /home/project prefix to store relative paths only
      if (sanitizedPath.startsWith(WORK_DIR + '/')) {
        sanitizedPath = sanitizedPath.slice(WORK_DIR.length + 1);
      } else if (sanitizedPath === WORK_DIR || sanitizedPath === '/home') {
        continue; // Skip root directories entirely
      }

      // Skip empty paths
      if (!sanitizedPath) {
        continue;
      }

      switch (type) {
        case 'add_dir': {
          // we intentionally add a trailing slash so we can distinguish files from folders in the file tree
          updates[sanitizedPath] = { type: 'folder' };
          hasChanges = true;
          break;
        }
        case 'remove_dir': {
          updates[sanitizedPath] = undefined;
          hasChanges = true;

          /*
           * Mark all known children for deletion
           * Check current files
           */
          for (const [direntPath] of Object.entries(currentFiles)) {
            if (direntPath.startsWith(sanitizedPath + '/')) {
              updates[direntPath] = undefined;
            }
          }

          // Also check pending updates (in case we added something in this batch then removed parent)
          for (const [direntPath] of Object.entries(updates)) {
            if (direntPath.startsWith(sanitizedPath + '/') && updates[direntPath] !== undefined) {
              updates[direntPath] = undefined;
            }
          }

          break;
        }
        case 'add_file':
        case 'change': {
          /*
           * Skip watcher updates for files that were just saved programmatically
           * to prevent race condition where watcher receives empty content first
           */
          if (this.#recentlySavedFiles.has(sanitizedPath)) {
            logger.debug('Skipping watcher update for recently saved file', { path: sanitizedPath });
            break;
          }

          if (type === 'add_file') {
            sizeDelta++;
          }

          let content = '';

          /**
           * @note This check is purely for the editor. The way we detect this is not
           * bullet-proof and it's a best guess so there might be false-positives.
           * The reason we do this is because we don't want to display binary files
           * in the editor nor allow to edit them.
           */
          const isBinary = isBinaryFile(buffer);

          if (!isBinary) {
            content = this.#decodeFileContent(buffer);
          }

          logger.debug('File watcher change event', {
            path: sanitizedPath,
            type,
            contentLength: content.length,
            contentPreview: content.substring(0, 200),
          });

          updates[sanitizedPath] = { type: 'file', content, isBinary };
          hasChanges = true;

          break;
        }
        case 'remove_file': {
          sizeDelta--;
          updates[sanitizedPath] = undefined;
          hasChanges = true;
          break;
        }
        case 'update_directory': {
          // we don't care about these events
          break;
        }
      }
    }

    // Apply updates
    if (hasChanges) {
      this.#size += sizeDelta;
      this.files.set({ ...currentFiles, ...updates });
      logger.debug(`Batch updated ${Object.keys(updates).length} paths`);
    }

    console.timeEnd('FilesStore:processEventBuffer');
  }

  #decodeFileContent(buffer?: Uint8Array) {
    if (!buffer || buffer.byteLength === 0) {
      return '';
    }

    try {
      return utf8TextDecoder.decode(buffer);
    } catch (error) {
      console.log(error);
      return '';
    }
  }

  /**
   * Ensures all parent directories of a path exist in the files store.
   * This is necessary because mkdir() creates directories in WebContainer,
   * but the file watcher events are buffered and may not fire before UI renders.
   */
  #ensureParentFolders(filePath: string) {
    const parts = filePath.split('/');
    let currentPath = '';

    // Iterate through all parent directories (exclude the file itself)
    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];

      // Only add if not already present
      if (!this.files.get()[currentPath]) {
        this.files.setKey(currentPath, { type: 'folder' });
      }
    }
  }

  /**
   * Saves a file with optimistic UI updates and batched cloud syncing.
   * This is the primary method for writing files in the Cloud-Native flow.
   */
  async saveFile(filePath: string, content: string | Uint8Array = '') {
    const webcontainer = await this.#webcontainer;

    try {
      const relativePath = validateAndNormalizePath(webcontainer.workdir, filePath);
      const dirPath = path.dirname(relativePath);
      const isBinary = content instanceof Uint8Array;

      // 1. Ensure parent folders exist (Optimistic Store Update)
      this.#ensureParentFolders(relativePath);

      /*
       * 1.5. Ensure console interceptor is present in HTML files
       * This catches cases where LLM edits might overwrite the interceptor
       */
      let finalContent = content;

      if (!isBinary && typeof content === 'string') {
        const { ensureConsoleInterceptor } = await import('~/lib/utils/ensure-console-interceptor');
        finalContent = ensureConsoleInterceptor(relativePath, content);
      }

      /*
       * 2. Update File State Immediately (Optimistic Store Update)
       * This allows the UI to reflect changes instantly without waiting for FS
       */
      const contentStr = isBinary
        ? Buffer.from(finalContent as Uint8Array).toString('base64')
        : (finalContent as string);

      this.files.setKey(relativePath, {
        type: 'file',
        content: contentStr,
        isBinary,
        isLocked: false,
      });

      this.#modifiedFiles.set(relativePath, contentStr);

      // 3. Queue for Cloud Sync (Batched)
      const syncContent = isBinary ? contentStr : (finalContent as string) || ' ';

      if (this.#fileSyncManager) {
        logger.info(`[FilesStore:${this.#instanceId}] Queuing write for ${relativePath}`, {
          hasManager: true,
          contentLength: syncContent.length,
        });

        this.#fileSyncManager.queueWrite(relativePath, syncContent);
      } else {
        // Buffer the write until manager is available
        logger.info(`[FilesStore:${this.#instanceId}] Buffering write for ${relativePath} (no manager yet)`);
        this.#pendingSyncs.set(relativePath, syncContent);
      }

      /*
       * 4. Persist to WebContainer (Background / Fire-and-Forget)
       * We don't await this to prevent blocking the action runner
       */
      (async () => {
        try {
          if (dirPath !== '.') {
            await webcontainer.fs.mkdir(dirPath, { recursive: true });
          }

          // Mark as recently saved to ignore the subsequent watcher event
          this.markRecentlySaved(relativePath, 2000);

          if (isBinary) {
            await webcontainer.fs.writeFile(relativePath, Buffer.from(finalContent as Uint8Array));
          } else {
            const contentToWrite = (finalContent as string).length === 0 ? ' ' : (finalContent as string);
            await webcontainer.fs.writeFile(relativePath, contentToWrite);
          }
        } catch (err) {
          logger.error('Background WebContainer write failed', err);
        }
      })();

      logger.info(`File saved (optimistic): ${relativePath}`);

      return true;
    } catch (error) {
      logger.error('Failed to save file\n\n', error);
      throw error;
    }
  }

  async createFolder(folderPath: string) {
    const webcontainer = await this.#webcontainer;

    try {
      const relativePath = validateAndNormalizePath(webcontainer.workdir, folderPath);

      await webcontainer.fs.mkdir(relativePath, { recursive: true });

      this.files.setKey(relativePath, { type: 'folder' });

      logger.info(`Folder created: ${relativePath}`);

      return true;
    } catch (error) {
      logger.error('Failed to create folder\n\n', error);
      throw error;
    }
  }

  async deleteFile(filePath: string) {
    const webcontainer = await this.#webcontainer;

    try {
      const relativePath = validateAndNormalizePath(webcontainer.workdir, filePath);

      await webcontainer.fs.rm(relativePath);

      this.#deletedPaths.add(relativePath);

      this.files.setKey(relativePath, undefined);
      this.#size--;

      if (this.#modifiedFiles.has(relativePath)) {
        this.#modifiedFiles.delete(relativePath);
      }

      this.#persistDeletedPaths();

      logger.info(`File deleted: ${relativePath}`);

      return true;
    } catch (error) {
      logger.error('Failed to delete file\n\n', error);
      throw error;
    }
  }

  async deleteFolder(folderPath: string) {
    const webcontainer = await this.#webcontainer;

    try {
      const relativePath = validateAndNormalizePath(webcontainer.workdir, folderPath);

      await webcontainer.fs.rm(relativePath, { recursive: true });

      this.#deletedPaths.add(relativePath);

      this.files.setKey(relativePath, undefined);

      const allFiles = this.files.get();

      for (const [filePath, dirent] of Object.entries(allFiles)) {
        if (filePath.startsWith(relativePath + '/')) {
          this.files.setKey(filePath, undefined);

          this.#deletedPaths.add(filePath);

          if (dirent?.type === 'file') {
            this.#size--;
          }

          if (dirent?.type === 'file' && this.#modifiedFiles.has(filePath)) {
            this.#modifiedFiles.delete(filePath);
          }
        }
      }

      this.#persistDeletedPaths();

      logger.info(`Folder deleted: ${relativePath}`);

      return true;
    } catch (error) {
      logger.error('Failed to delete folder\n\n', error);
      throw error;
    }
  }

  // method to persist deleted paths to localStorage
  #persistDeletedPaths() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('bolt-deleted-paths', JSON.stringify([...this.#deletedPaths]));
      }
    } catch (error) {
      logger.error('Failed to persist deleted paths to localStorage', error);
    }
  }
}

function isBinaryFile(buffer: Uint8Array | undefined) {
  if (buffer === undefined) {
    return false;
  }

  return getEncoding(convertToBuffer(buffer), { chunkLength: 100 }) === 'binary';
}

/**
 * Converts a `Uint8Array` into a Node.js `Buffer` by copying the prototype.
 * The goal is to  avoid expensive copies. It does create a new typed array
 * but that's generally cheap as long as it uses the same underlying
 * array buffer.
 */
function convertToBuffer(view: Uint8Array): Buffer {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}
