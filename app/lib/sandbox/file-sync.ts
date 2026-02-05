/**
 * File Sync Manager
 * Feature: 001-sandbox-providers
 *
 * Manages incremental file synchronization between the editor (Nanostores)
 * and the active sandbox provider. Supports batching and debouncing for efficiency.
 */

import type { SandboxProvider } from './types';
import type { FileSyncState } from '~/types/sandbox';

type SyncStateCallback = (state: FileSyncState) => void;

/**
 * Configuration for the FileSyncManager
 */
export interface FileSyncConfig {
  /** Debounce delay for batching writes (ms) */
  debounceMs?: number;

  /** Maximum files to batch in a single write */
  maxBatchSize?: number;

  /** Retry count for failed syncs */
  maxRetries?: number;

  /** Delay between retries (ms) */
  retryDelayMs?: number;
}

const DEFAULT_CONFIG: Required<FileSyncConfig> = {
  debounceMs: 100,
  maxBatchSize: 50,
  maxRetries: 3,
  retryDelayMs: 1000,
};

/**
 * FileSyncManager coordinates file synchronization between the editor
 * and the sandbox provider, handling batching, debouncing, and error recovery.
 */
export class FileSyncManager {
  private _provider: SandboxProvider | null = null;
  private _config: Required<FileSyncConfig>;
  private _state: FileSyncState = {
    pendingWrites: [],
    syncing: [],
    syncedAt: {},
    errors: {},
  };
  private _stateCallbacks: Set<SyncStateCallback> = new Set();
  private _debounceTimer: NodeJS.Timeout | null = null;
  private _isDisposed = false;

  constructor(config?: FileSyncConfig) {
    this._config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the active provider
   */
  setProvider(provider: SandboxProvider | null): void {
    this._provider = provider;

    // Clear pending state when provider changes
    if (!provider) {
      this._clearPending();
    }
  }

  /**
   * Get current sync state
   */
  getState(): FileSyncState {
    return { ...this._state };
  }

  /**
   * Subscribe to sync state changes
   */
  onStateChange(callback: SyncStateCallback): () => void {
    this._stateCallbacks.add(callback);
    return () => this._stateCallbacks.delete(callback);
  }

  /**
   * Queue a file for synchronization
   */
  queueWrite(path: string, content: string): void {
    if (this._isDisposed) {
      return;
    }

    // Add to pending if not already there
    if (!this._state.pendingWrites.includes(path)) {
      this._state.pendingWrites.push(path);
      this._notifyStateChange();
    }

    // Store content for the write (using a separate map)
    this._pendingContent.set(path, content);

    // Debounce the actual sync
    this._scheduleSync();
  }

  private _pendingContent: Map<string, string> = new Map();

  /**
   * Immediately flush all pending writes
   */
  async flushWrites(): Promise<void> {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    await this._performSync();
  }

  /**
   * Retry all failed syncs
   */
  async retrySyncErrors(): Promise<void> {
    const errorPaths = Object.keys(this._state.errors);

    if (errorPaths.length === 0) {
      return;
    }

    // Re-queue errored files (content needs to be provided again)
    for (const path of errorPaths) {
      this._state.pendingWrites.push(path);
    }

    // Clear errors
    this._state.errors = {};
    this._notifyStateChange();

    // Trigger sync
    await this._performSync();
  }

  /**
   * Clear a specific sync error
   */
  clearSyncError(path: string): void {
    if (this._state.errors[path]) {
      delete this._state.errors[path];
      this._notifyStateChange();
    }
  }

  /**
   * Dispose of the sync manager
   */
  dispose(): void {
    this._isDisposed = true;

    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    this._clearPending();
    this._stateCallbacks.clear();
  }

  /*
   * -------------------------------------------------------------------------
   * Private Methods
   * -------------------------------------------------------------------------
   */

  private _scheduleSync(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }

    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._performSync();
    }, this._config.debounceMs);
  }

  private async _performSync(): Promise<void> {
    console.log('[FileSyncManager] _performSync called', {
      hasProvider: !!this._provider,
      pendingWrites: this._state.pendingWrites.length,
      providerStatus: this._provider?.status,
      providerType: this._provider?.type,
    });

    if (!this._provider || this._state.pendingWrites.length === 0) {
      console.log('[FileSyncManager] Skipping sync - no provider or no pending writes');
      return;
    }

    // Take a batch of files to sync
    const batch = this._state.pendingWrites.splice(0, this._config.maxBatchSize);

    // Move to syncing state
    this._state.syncing.push(...batch);
    this._notifyStateChange();

    // Prepare files for writing
    const files: Array<{ path: string; content: Buffer }> = [];

    for (const path of batch) {
      const content = this._pendingContent.get(path);

      if (content !== undefined) {
        files.push({
          path,
          content: Buffer.from(content, 'utf-8'),
        });
        this._pendingContent.delete(path);
      }
    }

    if (files.length === 0) {
      // No actual content to sync
      this._state.syncing = this._state.syncing.filter((p) => !batch.includes(p));
      this._notifyStateChange();

      return;
    }

    console.log('[FileSyncManager] Writing files to provider', {
      fileCount: files.length,
      paths: files.map((f) => f.path),
    });

    // Perform the sync with retries
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this._config.maxRetries; attempt++) {
      try {
        await this._provider.writeFiles(files);
        console.log('[FileSyncManager] Files written successfully', { fileCount: files.length });

        // Success - update synced timestamps
        const now = Date.now();

        for (const file of files) {
          this._state.syncedAt[file.path] = now;
        }

        // Remove from syncing
        this._state.syncing = this._state.syncing.filter((p) => !batch.includes(p));
        this._notifyStateChange();

        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this._config.maxRetries - 1) {
          // Wait before retry
          await new Promise((resolve) => setTimeout(resolve, this._config.retryDelayMs));
        }
      }
    }

    // All retries failed - record errors
    for (const path of batch) {
      this._state.errors[path] = lastError?.message || 'Sync failed';
    }

    // Remove from syncing
    this._state.syncing = this._state.syncing.filter((p) => !batch.includes(p));
    this._notifyStateChange();
  }

  private _clearPending(): void {
    this._state = {
      pendingWrites: [],
      syncing: [],
      syncedAt: this._state.syncedAt,
      errors: {},
    };
    this._pendingContent.clear();
    this._notifyStateChange();
  }

  private _notifyStateChange(): void {
    const state = this.getState();
    this._stateCallbacks.forEach((cb) => cb(state));
  }
}

// Singleton instance for app-wide file sync
let globalFileSyncManager: FileSyncManager | null = null;

/**
 * Get the global FileSyncManager instance
 */
export function getFileSyncManager(): FileSyncManager {
  if (!globalFileSyncManager) {
    globalFileSyncManager = new FileSyncManager();
  }

  return globalFileSyncManager;
}

/**
 * Reset the global FileSyncManager (for testing)
 */
export function resetFileSyncManager(): void {
  if (globalFileSyncManager) {
    globalFileSyncManager.dispose();
    globalFileSyncManager = null;
  }
}
