import { atom, map, type MapStore, type ReadableAtom, type WritableAtom } from 'nanostores';
import type { EditorDocument, ScrollPosition } from '~/components/editor/codemirror/CodeMirrorEditor';
import { ActionRunner } from '~/lib/runtime/action-runner';
import type { ActionCallbackData, ArtifactCallbackData } from '~/lib/runtime/message-parser';
import { webcontainer } from '~/lib/webcontainer';
import type { ITerminal } from '~/types/terminal';
import { unreachable } from '~/utils/unreachable';
import { EditorStore } from './editor';
import { FilesStore, type FileMap } from './files';
import { PreviewsStore } from './previews';
import { TerminalStore } from './terminal';
import JSZip from 'jszip';
import fileSaver from 'file-saver';
import { Octokit, type RestEndpointMethodTypes } from '@octokit/rest';
import { path } from '~/utils/path';
import { extractRelativePath } from '~/utils/diff';
import { description } from '~/lib/persistence';
import Cookies from 'js-cookie';
import { createSampler } from '~/utils/sampler';
import type { ActionAlert, DeployAlert, SupabaseAlert } from '~/types/actions';
import { createScopedLogger } from '~/utils/logger';
import type { SandboxProvider, SandboxProviderType } from '~/lib/sandbox/types';
import { createSandboxProvider, resolveProviderType } from '~/lib/sandbox';
import { FileSyncManager } from '~/lib/sandbox/file-sync';
import { TimeoutManager, type TimeoutManagerConfig } from '~/lib/sandbox/timeout-manager';

const { saveAs } = fileSaver;
const logger = createScopedLogger('WorkbenchStore');

/**
 * Chunk files into batches under maxChunkSize bytes.
 * Used for Vercel Sandbox uploads (4MB limit).
 */
function createChunksStrict(
  files: Array<{ path: string; content: any; size: number; encoding?: string }>,
  maxChunkSize: number,
): Array<Array<{ path: string; content: any; encoding?: string }>> {
  const chunks: Array<Array<{ path: string; content: any; encoding?: string }>> = [];
  let currentChunk: Array<{ path: string; content: any; encoding?: string }> = [];
  let currentSize = 0;

  for (const file of files) {
    // If single file exceeds limit, upload it alone (will likely fail but we try)
    if (file.size > maxChunkSize) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentSize = 0;
      }

      chunks.push([{ path: file.path, content: file.content, encoding: file.encoding }]);
      continue;
    }

    /*
     * If adding this file would exceed byte limit OR file count limit, start new chunk.
     * Vercel Sandbox API has a 4 MB request limit — we target 3 MB to leave headroom.
     * File count capped at 50 to avoid excessive file-handle churn on the sandbox.
     */
    const MAX_FILES_PER_CHUNK = 50;

    if (
      (currentSize + file.size > maxChunkSize || currentChunk.length >= MAX_FILES_PER_CHUNK) &&
      currentChunk.length > 0
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }

    currentChunk.push({ path: file.path, content: file.content, encoding: file.encoding });
    currentSize += file.size;
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

export interface ArtifactState {
  id: string;
  title: string;
  type?: string;
  closed: boolean;
  runner: ActionRunner;
  messageId: string;
}

export type ArtifactUpdateState = Pick<ArtifactState, 'title' | 'closed'>;

type Artifacts = MapStore<Record<string, ArtifactState>>;

export type WorkbenchViewType = 'code' | 'diff' | 'preview';

export class WorkbenchStore {
  #previewsStore = new PreviewsStore(webcontainer);
  #filesStore = new FilesStore(webcontainer);
  #editorStore = new EditorStore(this.#filesStore);
  #terminalStore = new TerminalStore(webcontainer);

  // Sandbox provider support (001-sandbox-providers)
  #sandboxProvider: SandboxProvider | null = null;
  #fileSyncManager: FileSyncManager | null = null;
  #timeoutManager: TimeoutManager | null = null;
  #isRecreating = false; // Prevent concurrent sandbox recreations
  #lastUserInteractionAt = 0; // Timestamp of last real DOM interaction
  #recreationCount = 0; // Consecutive auto-recreations without user activity
  #domActivityCleanup: (() => void) | null = null; // DOM listener cleanup
  #activityTrackingStarted = false; // Prevent double-attaching DOM listeners
  #devServerStarting = false; // Track when dev server is starting up
  #devServerReadyPromise: Promise<void> | null = null; // Promise that resolves when dev server is ready

  // Project state for reconnection
  #currentProjectId: string | null = null;
  #currentUserId: string | null = null;
  #currentProviderType: SandboxProviderType = 'webcontainer';

  // Snapshot conflict detection (multi-tab safety)
  #sessionStartedAt: number = Date.now();
  #lastKnownSnapshotUpdatedAt: string | null = null;

  #reloadedMessages = new Set<string>();

  artifacts: Artifacts = import.meta.hot?.data.artifacts ?? map({});

  showWorkbench: WritableAtom<boolean> = import.meta.hot?.data.showWorkbench ?? atom(false);
  currentView: WritableAtom<WorkbenchViewType> = import.meta.hot?.data.currentView ?? atom('code');
  unsavedFiles: WritableAtom<Set<string>> = import.meta.hot?.data.unsavedFiles ?? atom(new Set<string>());
  actionAlert: WritableAtom<ActionAlert | undefined> =
    import.meta.hot?.data.actionAlert ?? atom<ActionAlert | undefined>(undefined);
  supabaseAlert: WritableAtom<SupabaseAlert | undefined> =
    import.meta.hot?.data.supabaseAlert ?? atom<SupabaseAlert | undefined>(undefined);
  deployAlert: WritableAtom<DeployAlert | undefined> =
    import.meta.hot?.data.deployAlert ?? atom<DeployAlert | undefined>(undefined);

  /**
   * Status of the initial project load sequence.
   * null = ready / not loading
   */
  loadingStatus: WritableAtom<string | null> = import.meta.hot?.data.loadingStatus ?? atom<string | null>(null);

  /**
   * Signal for Preview.tsx to reload iframe after successful file sync to Vercel sandbox.
   * Set to Date.now() when files are synced; Preview.tsx watches and debounces the reload.
   */
  vercelPreviewRefreshSignal: WritableAtom<number> =
    import.meta.hot?.data.vercelPreviewRefreshSignal ?? atom<number>(0);

  modifiedFiles = new Set<string>();
  artifactIdList: string[] = [];
  #globalExecutionQueue = Promise.resolve();
  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.artifacts = this.artifacts;
      import.meta.hot.data.unsavedFiles = this.unsavedFiles;
      import.meta.hot.data.showWorkbench = this.showWorkbench;
      import.meta.hot.data.currentView = this.currentView;
      import.meta.hot.data.actionAlert = this.actionAlert;
      import.meta.hot.data.supabaseAlert = this.supabaseAlert;
      import.meta.hot.data.deployAlert = this.deployAlert;
      import.meta.hot.data.vercelPreviewRefreshSignal = this.vercelPreviewRefreshSignal;

      // Ensure binary files are properly preserved across hot reloads
      const filesMap = this.files.get();

      for (const [path, dirent] of Object.entries(filesMap)) {
        if (dirent?.type === 'file' && dirent.isBinary && dirent.content) {
          // Make sure binary content is preserved
          this.files.setKey(path, { ...dirent });
        }
      }
    }
  }

  addToExecutionQueue(callback: () => Promise<void>) {
    this.#globalExecutionQueue = this.#globalExecutionQueue.then(async () => {
      try {
        await callback();
      } catch (error) {
        logger.error('Execution queue error:', error);

        // Surface the error to the user via actionAlert
        this.actionAlert.set({
          type: 'error',
          title: 'Failed to apply file changes',
          description: error instanceof Error ? error.message : String(error),
          content: '',
        });
      }
    });
  }

  /**
   * Wait for all queued actions to complete.
   * Used to ensure file writes are finished before taking snapshots.
   */
  async waitForActionsToComplete(): Promise<void> {
    // First wait for all additions to the queue
    await this.#globalExecutionQueue;

    // Then wait for each artifact's ActionRunner to complete its execution
    const artifacts = this.artifacts.get();
    const runnerPromises = Object.values(artifacts)
      .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== undefined)
      .map((artifact) => artifact.runner.waitForCompletion());

    await Promise.all(runnerPromises);
  }

  /*
   * ============================================================================
   * Sandbox Provider Methods (001-sandbox-providers)
   * ============================================================================
   */

  get sandboxProvider(): SandboxProvider | null {
    return this.#sandboxProvider;
  }

  get filesStore(): FilesStore {
    return this.#filesStore;
  }

  get fileSyncManager(): FileSyncManager | null {
    return this.#fileSyncManager;
  }

  get timeoutManager(): TimeoutManager | null {
    return this.#timeoutManager;
  }

  get currentProjectId(): string | null {
    return this.#currentProjectId;
  }

  get currentProviderType(): SandboxProviderType {
    return this.#currentProviderType;
  }

  /**
   * Get sandbox lifetime information (remaining time, expiration status)
   * Returns null if no sandbox is active or timeout tracking is not available
   */
  getSandboxLifetime(): {
    timeRemainingMs: number;
    timeRemainingMinutes: number;
    isExpired: boolean;
    warningShown: boolean;
  } | null {
    if (!this.#timeoutManager) {
      return null;
    }

    const state = this.#timeoutManager.getState();

    return {
      timeRemainingMs: state.timeRemainingMs,
      timeRemainingMinutes: Math.floor(state.timeRemainingMs / 60000),
      isExpired: state.isExpired,
      warningShown: state.warningShown,
    };
  }

  /**
   * Get the FileSyncManager for controlling file sync behavior.
   * Used by ActionRunner to enable/disable streaming mode.
   */
  getFileSyncManager(): FileSyncManager | null {
    return this.#fileSyncManager;
  }

  /**
   * Initialize the sandbox provider for the current project.
   * This wires up the provider to FilesStore (via FileSyncManager) and PreviewsStore.
   *
   * @param providerType - The type of provider to use ('webcontainer' or 'vercel')
   * @param projectId - The project ID for sandbox association
   * @param userId - The user ID for authentication
   * @param snapshotId - Optional snapshot ID to restore from
   * @returns The initialized provider instance
   */
  async initializeProvider(
    providerType: SandboxProviderType,
    projectId: string,
    userId: string,
    snapshotId?: string,
  ): Promise<SandboxProvider> {
    // Disconnect existing provider if any
    if (this.#sandboxProvider) {
      logger.info('Disconnecting existing sandbox provider');

      // Stop timeout manager
      if (this.#timeoutManager) {
        this.#timeoutManager.stop();
        this.#timeoutManager = null;
      }

      await this.#sandboxProvider.disconnect();
      this.#sandboxProvider = null;
      this.#fileSyncManager = null;
      this.#filesStore.setFileSyncManager(null);
    }

    // Track current project state
    this.#currentProjectId = projectId;
    this.#currentUserId = userId;
    this.#currentProviderType = providerType;

    this.loadingStatus.set('Initializing...');

    // Create new provider
    logger.info('Initializing sandbox provider', { providerType, projectId });

    const provider = await createSandboxProvider(providerType, {
      projectId,
      userId,
      snapshotId,
      workdir: '/home/project',
      timeout: 5 * 60 * 1000, // 5 minutes default
      ports: [3000, 5173],
      runtime: 'node22',
    });

    this.#sandboxProvider = provider;

    // Set up FileSyncManager for cloud providers
    if (providerType === 'vercel') {
      this.#fileSyncManager = new FileSyncManager({
        maxBatchSize: 50,
        debounceMs: 300,
        onSyncSuccess: (_paths) => {
          // Signal Preview.tsx to reload iframe after files synced
          this.vercelPreviewRefreshSignal.set(Date.now());
        },
        onSyncFailure: (paths, error) => {
          const is410 = error.includes('410') || error.includes('SANDBOX_EXPIRED') || error.includes('gone');

          if (!is410) {
            logger.warn('File sync failed (non-sandbox error)', { paths, error });
            return;
          }

          // Sandbox is dead — show notification, user must click Restart
          logger.info('File sync: sandbox expired — showing notification');
          this.actionAlert.set({
            type: 'warning',
            title: 'Session Expired',
            description: 'Your preview session has ended. Click Restart to continue.',
            content: '',
          });
        },
      });
      this.#fileSyncManager.setProvider(provider);
      this.#filesStore.setFileSyncManager(this.#fileSyncManager);

      /*
       * Listen for preview ready events — store URLs but DON'T register yet.
       * Registration happens in #autoStartDevServer after the dev server launches,
       * preventing the iframe from loading before there's anything to show.
       */
      provider.onPreviewReady((port, url) => {
        logger.info('Preview URL available (deferred registration)', { port, url });
      });

      // Set up timeout management for Vercel
      this._setupTimeoutManager(provider, projectId, userId);
    }

    // Listen for file changes from provider (sync back to store)
    provider.onFileChange((event) => {
      // Defensive: don't log content even if it arrives (can be very large)
      logger.debug('File change from provider', {
        type: event.type,
        path: event.path,
        hasContent: !!event.content && event.content.length > 0,
        contentLength: event.content?.length,
      });

      /*
       * Note: The store already updates via WebContainer watcher for local
       * For cloud, we might need to sync back here in future
       */
    });

    logger.info('Sandbox provider initialized', { providerType, sandboxId: provider.sandboxId });

    // Start DOM activity tracking for idle cost protection
    this.#startUserActivityTracking();

    return provider;
  }

  /**
   * Disconnect the current sandbox provider.
   * Saves a snapshot before disconnecting for faster restoration.
   */
  async disconnectProvider(saveSnapshot: boolean = true): Promise<void> {
    if (this.#sandboxProvider) {
      logger.info('Disconnecting sandbox provider', { saveSnapshot });

      // Save snapshot before disconnecting (for Vercel only)
      if (saveSnapshot && this.#sandboxProvider.type === 'vercel' && this.#currentProjectId) {
        try {
          await this.saveSnapshotToDatabase();
          logger.info('Snapshot saved before disconnect');
        } catch (error) {
          logger.warn('Failed to save snapshot before disconnect', error);

          // Continue with disconnect even if snapshot fails
        }
      }

      // Stop timeout manager
      if (this.#timeoutManager) {
        this.#timeoutManager.stop();
        this.#timeoutManager = null;
      }

      await this.#sandboxProvider.disconnect();
      this.#sandboxProvider = null;
      this.#fileSyncManager = null;
      this.#filesStore.setFileSyncManager(null);
      this.#currentProjectId = null;
      this.#currentUserId = null;

      // Clean up DOM activity listeners
      this.#domActivityCleanup?.();
      this.#domActivityCleanup = null;
    }
  }

  /**
   * Reconnect to an existing sandbox or restore from snapshot.
   * Called on page load/refresh to restore the workspace session.
   *
   * @param projectId - The project ID
   * @param userId - The user ID
   * @param sandboxId - Optional sandbox ID from project record
   * @param sandboxProvider - Optional provider type from project record
   * @param userPreference - Optional user preference for provider
   * @returns Object with success status and provider instance
   */
  async reconnectOrRestore(
    projectId: string,
    userId?: string,
    sandboxId?: string | null,
    sandboxProvider?: SandboxProviderType | null,
    userPreference?: SandboxProviderType,
  ): Promise<{ success: boolean; provider: SandboxProvider | null; restored: boolean }> {
    console.log('🔥🔥🔥 reconnectOrRestore CALLED', { projectId, userId, sandboxId, sandboxProvider, userPreference });
    logger.info('Attempting to reconnect or restore session', {
      projectId,
      hasSandboxId: !!sandboxId,
      sandboxProvider,
      userPreference,
    });

    // If sandbox details not provided, fetch from API
    if (!sandboxId || !sandboxProvider) {
      try {
        const response = await fetch(`/api/projects/${projectId}`);

        if (response.ok) {
          const project = (await response.json()) as {
            sandbox_id?: string | null;
            sandbox_provider?: SandboxProviderType | null;
            user_id?: string;
          };
          sandboxId = project.sandbox_id ?? null;
          sandboxProvider = project.sandbox_provider ?? null;

          // Use project's user_id if userId not provided
          if (!userId && project.user_id) {
            userId = project.user_id;
          }

          logger.info('Fetched project details for sandbox restore', {
            projectId,
            hasSandboxId: !!sandboxId,
            sandboxProvider,
          });
        }
      } catch (error) {
        logger.warn('Failed to fetch project details for sandbox restore', { error, projectId });
      }
    }

    // Determine which provider to use
    const providerType = resolveProviderType(userPreference, sandboxProvider ?? undefined);

    this.#currentProviderType = providerType;
    this.#currentProjectId = projectId;
    this.#currentUserId = userId || 'anonymous';

    /*
     * PHASE 2: Check for Vercel snapshot BEFORE trying to reconnect
     * If a Vercel snapshot exists, restore from it instead of reconnecting
     * This is much faster (5-10s vs 70-100s) because node_modules are already installed
     */
    console.log('🔥🔥🔥 Snapshot check condition:', {
      providerType,
      userId,
      condition: providerType === 'vercel' && !!userId,
    });

    if (providerType === 'vercel' && userId) {
      try {
        logger.info('Checking for Vercel snapshot before reconnect', { projectId, userId });
        console.log('🚀 Checking for Vercel snapshot before reconnect');

        // Fetch latest snapshot via API (client-side can't access server-only modules)
        console.log('🔥🔥🔥 Fetching snapshot from API:', `/api/projects/${projectId}/snapshot`);

        const snapshotResponse = await fetch(`/api/projects/${projectId}/snapshot`);
        console.log('🔥🔥🔥 Snapshot API response:', {
          status: snapshotResponse.status,
          ok: snapshotResponse.ok,
        });

        if (!snapshotResponse.ok) {
          console.log('ℹ️ No snapshot found, will try reconnect');
        } else {
          const latestSnapshot = (await snapshotResponse.json()) as {
            id: string;
            vercel_snapshot_id?: string | null;
            files?: Record<string, any>;
          };
          console.log('🔥🔥🔥 Snapshot data received:', {
            id: latestSnapshot.id,
            hasVercelSnapshotId: !!latestSnapshot.vercel_snapshot_id,
            vercelSnapshotId: latestSnapshot.vercel_snapshot_id,
          });

          if (latestSnapshot?.vercel_snapshot_id) {
            logger.info('Found Vercel snapshot, attempting restore', {
              projectId,
              vercelSnapshotId: latestSnapshot.vercel_snapshot_id,
            });
            console.log('🚀 Found Vercel snapshot:', latestSnapshot.vercel_snapshot_id);

            this.loadingStatus.set('Restoring from snapshot...');

            const response = await fetch(`/api/sandbox/snapshot/${latestSnapshot.vercel_snapshot_id}/restore`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                projectId,
                useVercelSnapshot: true,
              }),
            });

            if (response.ok) {
              const data = (await response.json()) as {
                success: boolean;
                sandboxId: string;
                previewUrls: Record<number, string>;
              };

              logger.info('Successfully restored from Vercel snapshot', {
                projectId,
                newSandboxId: data.sandboxId,
              });
              console.log('🚀 Successfully restored from Vercel snapshot:', data.sandboxId);

              /*
               * Create provider for the restored sandbox
               * Use skipConnect: true since the sandbox is already created via restore API
               */
              const providerConfig = {
                projectId,
                userId,
                snapshotId: latestSnapshot.vercel_snapshot_id,
                workdir: '/home/project',
                timeout: 5 * 60 * 1000,
                ports: [3000, 5173],
                runtime: 'node22' as const,
              };
              const provider = await createSandboxProvider(providerType, providerConfig, {
                skipConnect: true, // Skip connect - sandbox already exists
              });

              /*
               * Set up the provider with the restored sandbox data
               * No API call needed - restore API already verified and returned all data
               */
              (provider as any).setupFromRestore(
                providerConfig,
                data.sandboxId,
                data.previewUrls,
                5 * 60 * 1000, // 5 minutes default timeout
              );

              this.#sandboxProvider = provider;

              // Set up FileSyncManager
              this.#fileSyncManager = new FileSyncManager({
                maxBatchSize: 50,
                debounceMs: 300,
                onSyncSuccess: (_paths) => {
                  this.vercelPreviewRefreshSignal.set(Date.now());
                },
                onSyncFailure: (paths, error) => {
                  const is410 = error.includes('410') || error.includes('SANDBOX_EXPIRED') || error.includes('gone');

                  if (!is410) {
                    logger.warn('File sync failed (non-sandbox error)', { paths, error });
                    return;
                  }

                  this.actionAlert.set({
                    type: 'warning',
                    title: 'Session Expired',
                    description: 'Your preview session has ended. Click Restart to continue.',
                    content: '',
                  });
                },
              });
              this.#fileSyncManager.setProvider(provider);
              this.#filesStore.setFileSyncManager(this.#fileSyncManager);

              // Register preview URLs
              for (const [port, url] of Object.entries(data.previewUrls)) {
                this.#previewsStore.registerPreview(parseInt(port, 10), url, 'vercel');
              }

              // Set up timeout management
              this._setupTimeoutManager(provider, projectId, userId);

              // Load editor files from Supabase (fast, no upload to sandbox needed)
              await this.#loadSnapshotIntoFileStore();

              // Start DOM activity tracking
              this.#startUserActivityTracking();

              // Auto-start dev server (packages already installed!)
              if (latestSnapshot.files) {
                await this.#autoStartDevServer(
                  Object.fromEntries(
                    Object.entries(latestSnapshot.files).filter(([_, f]) => f?.type === 'file') as [
                      string,
                      { content: string; isBinary: boolean },
                    ][],
                  ),
                );
              }

              this.loadingStatus.set(null);

              return { success: true, provider, restored: true };
            } else {
              // Snapshot restore failed, fall through to reconnect
              logger.warn('Vercel snapshot restore failed, falling back to reconnect', {
                projectId,
                status: response.status,
              });
              console.log('⚠️ Vercel snapshot restore failed, falling back to reconnect');
            }
          }
        }
      } catch (error) {
        // Snapshot check/restore failed, fall through to reconnect
        logger.warn('Error checking/restoring Vercel snapshot, falling back to reconnect', {
          projectId,
          error,
        });
        console.log('⚠️ Error checking Vercel snapshot:', error);
      }
    }

    // If we have a sandboxId and it's a Vercel provider, try to reconnect
    if (sandboxId && providerType === 'vercel') {
      try {
        // Ensure userId is defined
        const effectiveUserId = userId || 'anonymous';

        console.log('[WorkbenchStore] Creating provider for reconnect', { sandboxId, providerType });

        // Create provider without connecting (we'll reconnect instead)
        const provider = await createSandboxProvider(
          providerType,
          {
            projectId,
            userId: effectiveUserId,
            workdir: '/home/project',
            timeout: 5 * 60 * 1000,
            ports: [3000, 5173],
            runtime: 'node22',
          },
          { skipConnect: true }, // Skip connect - we'll reconnect instead
        );

        console.log('[WorkbenchStore] Provider created, attempting reconnect', {
          sandboxId,
          providerStatus: provider.status,
        });

        // Try to reconnect to existing sandbox
        const reconnected = await provider.reconnect(sandboxId);

        console.log('[WorkbenchStore] Reconnect result:', { reconnected, providerStatus: provider.status });

        if (reconnected) {
          logger.info('Successfully reconnected to existing sandbox', { sandboxId });

          this.#sandboxProvider = provider;

          // Start DOM activity tracking for idle cost protection
          this.#startUserActivityTracking();

          // Set up FileSyncManager
          this.#fileSyncManager = new FileSyncManager({
            maxBatchSize: 50,
            debounceMs: 300,
            onSyncSuccess: (_paths) => {
              // Signal Preview.tsx to reload iframe after files synced
              this.vercelPreviewRefreshSignal.set(Date.now());
            },
            onSyncFailure: async (paths, error) => {
              const is410 = error.includes('410') || error.includes('SANDBOX_EXPIRED') || error.includes('gone');

              if (!is410) {
                logger.warn('File sync failed (non-sandbox error)', { paths, error });
                return;
              }

              // Sandbox is dead — trigger auto-recovery
              logger.info('File sync: sandbox expired — triggering auto-recovery', { paths });

              if (this.#isRecreating) {
                logger.warn('Sandbox recreation already in progress, skipping auto-recovery');
                return;
              }

              try {
                this.#isRecreating = true;
                this.loadingStatus.set('Sandbox session expired. Recreating...');
                await this.#recreateSandbox();
                logger.info('Sandbox auto-recovery complete after file sync failure');

                // Retry the failed file sync after recovery
                if (this.#fileSyncManager) {
                  logger.debug('Retrying file sync after auto-recovery');
                  await this.#fileSyncManager.flushWrites();
                }
              } catch (recoveryError) {
                logger.error('Sandbox auto-recovery failed', { error: recoveryError });
                this.actionAlert.set({
                  type: 'error',
                  title: 'Session Recovery Failed',
                  description: 'Could not restore your session. Please refresh the page to continue.',
                  content: '',
                });
              } finally {
                this.#isRecreating = false;
              }
            },
          });
          this.#fileSyncManager.setProvider(provider);
          this.#filesStore.setFileSyncManager(this.#fileSyncManager);

          // Listen for preview URLs — deferred registration (happens after dev server starts)
          provider.onPreviewReady((port, url) => {
            logger.info('Preview URL available on reconnect (deferred registration)', { port, url });
          });

          // Set up timeout management
          this._setupTimeoutManager(provider, projectId, effectiveUserId);

          /*
           * Smart reconnection: check if the dev server is already running.
           * If it is, skip the full file re-upload + npm install + dev start cycle
           * and just populate the local editor file store.
           */
          console.log('🔥 Reconnected successfully, checking if dev server is already running');

          let sandboxAlreadyRunning = false;

          try {
            const previewUrls = provider.getPreviewUrls();
            const firstUrl = previewUrls.values().next().value as string | undefined;

            if (firstUrl) {
              const healthRes = await fetch('/api/sandbox/health', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: firstUrl }),
              });
              const healthData = (await healthRes.json()) as { ready?: boolean };

              if (healthData.ready) {
                sandboxAlreadyRunning = true;
                logger.info('Sandbox dev server already running, skipping full restore', { sandboxId });
                console.log('🔥 Sandbox already running — skipping file upload + npm install');

                // Populate editor file tree from DB snapshot (no upload)
                await this.#loadSnapshotIntoFileStore();

                // Register preview URLs so the iframe picks them up
                for (const [port, url] of previewUrls) {
                  this.#previewsStore.registerPreview(port, url, 'vercel');
                }

                this.loadingStatus.set(null);
              }
            }
          } catch (healthError) {
            logger.warn('Health check failed during smart reconnect, falling back to full restore', {
              error: healthError,
            });
          }

          // If sandbox wasn't already running, do the full restore
          if (!sandboxAlreadyRunning) {
            try {
              const restored = await this.restoreFromDatabaseSnapshot();

              if (restored) {
                logger.info('Files restored from snapshot after reconnect');
              } else {
                // No snapshot to restore, just sync current state
                this.saveSnapshotToDatabase()
                  .then(() => {
                    logger.info('Snapshot synced to Supabase after reconnect');
                  })
                  .catch((error) => {
                    logger.warn('Failed to sync snapshot after reconnect', { error });
                  });
              }
            } catch (restoreError) {
              logger.warn('Failed to restore from snapshot after reconnect', restoreError);

              // Fall back to saving current state
              this.saveSnapshotToDatabase().catch((error) => {
                logger.warn('Failed to sync snapshot after reconnect', { error });
              });
            }
          }

          return { success: true, provider, restored: true };
        } else {
          logger.info('Failed to reconnect to sandbox (likely expired), will create new one', {
            sandboxId,
            reason: 'Sandbox expired or stopped',
          });
          console.log('⚠️ Sandbox reconnection failed - sandbox may have expired after 5 minutes');

          // Show user-friendly message
          this.loadingStatus.set('Previous session expired. Creating new sandbox...');

          // Disconnect the failed provider
          await provider.disconnect();
        }
      } catch (error) {
        logger.error('Error reconnecting to sandbox', { error, sandboxId });
      } finally {
        if (!this.#sandboxProvider) {
          this.loadingStatus.set(null);
        }
      }
    }

    // If we get here, we need to create a new sandbox
    console.log('🔥 Creating new sandbox session, providerType:', providerType);
    logger.info('Creating new sandbox session', {
      providerType,
      reason: sandboxId ? 'reconnect_failed' : 'no_sandbox_id',
    });

    try {
      const provider = await this.initializeProvider(providerType, projectId, userId || 'anonymous');
      console.log('🔥 Provider initialized:', {
        providerType,
        newSandboxId: provider.sandboxId,
        oldSandboxId: sandboxId,
        providerStatus: provider.status,
      });

      // Update database with new sandbox ID
      if (provider.sandboxId && provider.sandboxId !== sandboxId) {
        console.log('🔥 Updating project with new sandbox ID:', {
          oldSandboxId: sandboxId,
          newSandboxId: provider.sandboxId,
          projectId,
        });

        try {
          const response = await fetch(`/api/projects/${projectId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sandbox_id: provider.sandboxId,
              sandbox_provider: providerType,
            }),
          });

          if (response.ok) {
            logger.info('Updated project with new sandbox ID', {
              projectId,
              sandboxId: provider.sandboxId,
              oldSandboxId: sandboxId,
            });
          } else {
            logger.warn('Failed to update project with new sandbox ID', {
              projectId,
              status: response.status,
            });
          }
        } catch (updateError) {
          logger.warn('Error updating project with new sandbox ID', { error: updateError });

          // Continue even if database update fails - not fatal
        }
      }

      // For Vercel provider, try to restore files from database snapshot
      if (providerType === 'vercel') {
        console.log('🔥 Calling restoreFromDatabaseSnapshot for vercel provider');

        try {
          const restored = await this.restoreFromDatabaseSnapshot();

          if (restored) {
            logger.info('Files restored from snapshot for new sandbox');
          }
        } catch (restoreError) {
          logger.warn('Failed to restore from snapshot', restoreError);

          // Continue without restoration - not fatal
        } finally {
          this.loadingStatus.set(null);
        }
      } else {
        this.loadingStatus.set(null);
      }

      return { success: true, provider, restored: false };
    } catch (error) {
      logger.error('Failed to create new sandbox', { error });
      return { success: false, provider: null, restored: false };
    }
  }

  /**
   * Set up timeout management for a provider
   */
  private _setupTimeoutManager(provider: SandboxProvider, projectId: string, _userId: string): void {
    if (provider.type !== 'vercel') {
      // WebContainer doesn't have timeouts
      return;
    }

    const config: TimeoutManagerConfig = {
      warningThresholdMs: 2 * 60 * 1000, // 2 minutes
      checkIntervalMs: 30 * 1000, // 30 seconds
      autoExtend: true,
      minAutoExtendIntervalMs: 60 * 1000, // 1 minute
      onWarning: (timeRemainingMs) => {
        logger.info('Timeout warning triggered - saving pre-emptive snapshot', { timeRemainingMs });

        /*
         * Save pre-emptive snapshot when warning is shown (2 min before timeout)
         * This provides an extra safety net before the final timeout snapshot
         */
        this.saveSnapshotToDatabase()
          .then(() => {
            logger.info('Pre-emptive snapshot saved successfully');
          })
          .catch((error) => {
            logger.warn('Failed to save pre-emptive snapshot', { error });

            // Non-fatal - will try again on actual timeout
          });

        // The UI will subscribe to timeout warnings via the timeoutManager
      },
      onTimeout: () => {
        logger.info('Session timeout occurred - saving snapshot before expiry');

        // Save snapshot before showing error (fire-and-forget, but log result)
        this.saveSnapshotToDatabase()
          .then(() => {
            logger.info('Snapshot saved successfully before timeout');
          })
          .catch((error) => {
            logger.error('Failed to save snapshot before timeout', { error });
          })
          .finally(() => {
            // Show warning alert after snapshot attempt (regardless of success)
            this.actionAlert.set({
              type: 'warning',
              title: 'Session Expired',
              description: 'Your sandbox session has expired. Your work has been saved. Click Restart to continue.',
              content: '',
            });
          });
      },
      onExtended: (durationMs) => {
        logger.info('Session extended', { durationMs });
      },
      requestExtend: async (durationMs) => {
        try {
          const response = await fetch('/api/sandbox/extend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId,
              sandboxId: provider.sandboxId,
              duration: durationMs,
            }),
          });
          return response.ok;
        } catch (error) {
          logger.error('Failed to extend timeout', { error });
          return false;
        }
      },
    };

    this.#timeoutManager = new TimeoutManager(config);
    this.#timeoutManager.start(provider);
  }

  /**
   * Record user activity for timeout auto-extension
   */
  recordActivity(type: 'file_write' | 'command' | 'preview_access' | 'user_interaction'): void {
    if (this.#timeoutManager) {
      this.#timeoutManager.recordActivity(type);
    }
  }

  /**
   * Request manual timeout extension
   */
  async requestTimeoutExtension(durationMs: number = 5 * 60 * 1000): Promise<boolean> {
    if (!this.#timeoutManager) {
      return false;
    }

    return this.#timeoutManager.requestExtension(durationMs);
  }

  /**
   * Start tracking real user interactions via DOM events.
   * Updates #lastUserInteractionAt and resets the consecutive recreation counter
   * whenever the user interacts with the page.
   */
  #startUserActivityTracking(): void {
    if (this.#activityTrackingStarted || typeof document === 'undefined') {
      return;
    }

    this.#activityTrackingStarted = true;
    this.#lastUserInteractionAt = Date.now();

    const onActivity = () => {
      this.#lastUserInteractionAt = Date.now();
      this.#recreationCount = 0;
      this.recordActivity('user_interaction');
    };

    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const;

    for (const e of events) {
      document.addEventListener(e, onActivity, { passive: true });
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        this.#lastUserInteractionAt = Date.now();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);

    this.#domActivityCleanup = () => {
      for (const e of events) {
        document.removeEventListener(e, onActivity);
      }

      document.removeEventListener('visibilitychange', onVisibility);
      this.#activityTrackingStarted = false;
    };

    // Stop sandbox when tab closes (using sendBeacon for guaranteed delivery)
    const onBeforeUnload = () => {
      if (this.#sandboxProvider?.type === 'vercel' && this.#sandboxProvider.sandboxId) {
        navigator.sendBeacon(
          '/api/sandbox/stop',
          JSON.stringify({
            projectId: this.#currentProjectId,
            sandboxId: this.#sandboxProvider.sandboxId,
            createSnapshot: true,
          }),
        );
      }
    };

    window.addEventListener('beforeunload', onBeforeUnload);

    // Extend cleanup to include beforeunload
    const originalCleanup = this.#domActivityCleanup;

    this.#domActivityCleanup = () => {
      originalCleanup?.();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }

  /**
   * Check if the user has been active recently.
   * Returns false if the tab is hidden or the user hasn't interacted within the threshold.
   */
  #isUserActive(thresholdMs = 2 * 60 * 1000): boolean {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return false;
    }

    if (this.#lastUserInteractionAt === 0) {
      return false;
    }

    return Date.now() - this.#lastUserInteractionAt < thresholdMs;
  }

  /**
   * Run a sandbox command with automatic retry on 410 (expired) errors.
   * If the sandbox expired, recreates it and retries the command once.
   */
  async #runCommandWithRetry(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; timeout?: number },
    maxRetries = 1,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Get provider fresh each attempt (it may change after recreation)
      const provider = this.#sandboxProvider;

      if (!provider) {
        throw new Error('No sandbox provider available');
      }

      try {
        return await provider.runCommand(cmd, args, opts);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        const is410Error =
          errorMessage.includes('410') || errorMessage.includes('expired') || errorMessage.includes('SANDBOX_EXPIRED');

        if (is410Error && attempt < maxRetries) {
          logger.warn('Sandbox expired during command, recreating', { cmd, attempt, error: errorMessage });

          if (this.#isRecreating) {
            logger.warn('Sandbox recreation already in progress, waiting...');
            await new Promise((resolve) => setTimeout(resolve, 3000));
            continue;
          }

          try {
            this.#isRecreating = true;
            await this.#recreateSandbox();
            logger.info('Sandbox recreated, retrying command', { cmd, attempt });
            continue;
          } finally {
            this.#isRecreating = false;
          }
        }

        throw error;
      }
    }

    throw new Error('Command failed after retries');
  }

  /**
   * Recreate the sandbox after expiration.
   * Stops the old sandbox, creates a new one, updates the database,
   * and restores files from snapshot.
   */
  async #recreateSandbox(): Promise<void> {
    const currentProvider = this.#sandboxProvider;
    const projectId = this.#currentProjectId;
    const userId = this.#currentUserId;
    const oldSandboxId = currentProvider?.sandboxId;

    if (!currentProvider || !projectId) {
      throw new Error('Cannot recreate sandbox: no provider or project ID');
    }

    logger.info('Recreating sandbox due to expiration', {
      projectId,
      oldSandboxId,
      providerType: this.#currentProviderType,
    });

    try {
      // 1. Stop old sandbox
      this.loadingStatus.set('Stopping expired sandbox...');

      try {
        await fetch('/api/sandbox/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            sandboxId: oldSandboxId,
            createSnapshot: false,
          }),
        });
        logger.info('Old sandbox stopped', { oldSandboxId });
      } catch (stopError) {
        logger.warn('Failed to stop old sandbox (may already be stopped)', stopError);
      }

      // 2. Disconnect provider (cleanup local state)
      await currentProvider.disconnect();
      this.#sandboxProvider = null;
      this.#fileSyncManager = null;
      this.#filesStore.setFileSyncManager(null);

      // Clear previews for old sandbox
      const previews = this.#previewsStore.previews.get();

      for (const preview of previews) {
        if (preview.provider === 'vercel') {
          this.#previewsStore.unregisterPreview(preview.port);
        }
      }

      // 3. Create new sandbox
      this.loadingStatus.set('Creating new sandbox...');

      const newProvider = await this.initializeProvider(this.#currentProviderType, projectId, userId || 'anonymous');

      logger.info('New sandbox created', {
        projectId,
        newSandboxId: newProvider.sandboxId,
        oldSandboxId,
      });

      /*
       * Note: Database is already updated with new sandbox ID by /api/sandbox/create
       * No need to update again here (avoids race conditions)
       */

      // 4. Restore files from database snapshot
      this.loadingStatus.set('Restoring files...');
      await this.restoreFromDatabaseSnapshot();

      // 5. Clear loading status on success
      this.loadingStatus.set(null);

      logger.info('Sandbox recreation complete', { projectId, newSandboxId: newProvider.sandboxId });
    } catch (error) {
      logger.error('Sandbox recreation failed', { error, projectId, oldSandboxId });
      this.loadingStatus.set('Failed to recreate sandbox');
      throw error;
    }
  }

  /**
   * Public wrapper around #recreateSandbox() with the #isRecreating guard.
   * Called from Preview.tsx when the refresh button detects a dead sandbox.
   */
  async recreateSandbox(): Promise<void> {
    if (this.#isRecreating) {
      logger.warn('Sandbox recreation already in progress');
      return;
    }

    // User-initiated: reset idle counters so activity gate doesn't block
    this.#lastUserInteractionAt = Date.now();
    this.#recreationCount = 0;

    try {
      this.#isRecreating = true;
      await this.#recreateSandbox();

      // Wait for dev server to be ready after user-initiated recreation
      logger.info('Waiting for dev server to be ready after recreation...');
      await this.waitForDevServerReady();
      logger.info('Sandbox recreation complete, dev server is ready');
    } finally {
      this.#isRecreating = false;
    }
  }

  /**
   * Switch the sandbox provider for the current project.
   * Disconnects the current provider and initializes a new one.
   *
   * @param newProviderType - The new provider type ('webcontainer' or 'vercel')
   * @returns The new provider instance
   */
  async switchProvider(newProviderType: SandboxProviderType): Promise<SandboxProvider> {
    const currentProjectId = this.#currentProjectId;
    const currentUserId = this.#currentUserId;

    if (!currentProjectId || !currentUserId) {
      throw new Error('No active project to switch provider for');
    }

    logger.info('Switching sandbox provider', {
      from: this.#currentProviderType,
      to: newProviderType,
      projectId: currentProjectId,
    });

    // Disconnect current provider
    await this.disconnectProvider();

    // Initialize new provider
    const provider = await this.initializeProvider(newProviderType, currentProjectId, currentUserId);

    // Update project record with new provider
    try {
      await fetch('/api/user/sandbox-preference', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredProvider: newProviderType }),
      });
    } catch (error) {
      logger.warn('Failed to update provider preference', { error });

      // Non-fatal - provider is already switched
    }

    logger.info('Provider switched successfully', {
      newProvider: newProviderType,
      sandboxId: provider.sandboxId,
    });

    return provider;
  }

  /**
   * Save the current file state as a snapshot to the database.
   * This allows fast restoration when reopening the project later.
   */
  async saveSnapshotToDatabase(): Promise<void> {
    const projectId = this.#currentProjectId;

    if (!projectId) {
      throw new Error('No active project to save snapshot for');
    }

    logger.info('Saving snapshot to database', { projectId });

    // Get current files
    const files = this.files.get();
    const filesToSave: Record<string, { content: string; isBinary: boolean }> = {};

    for (const [path, dirent] of Object.entries(files)) {
      if (dirent?.type === 'file' && !dirent.isBinary) {
        filesToSave[path] = {
          content: dirent.content,
          isBinary: dirent.isBinary,
        };
      }
    }

    const fileCount = Object.keys(filesToSave).length;

    if (fileCount === 0) {
      logger.warn('No files to save in snapshot');
      return;
    }

    /*
     * CONFLICT DETECTION: Check if snapshot was modified by another tab/session
     * This prevents silent data loss when multiple tabs are editing the same project
     */
    if (this.#lastKnownSnapshotUpdatedAt) {
      try {
        const checkResponse = await fetch(`/api/projects/${projectId}/snapshot`);

        if (checkResponse.ok) {
          const currentSnapshot = (await checkResponse.json()) as { updated_at: string };
          const lastKnown = new Date(this.#lastKnownSnapshotUpdatedAt).getTime();
          const current = new Date(currentSnapshot.updated_at).getTime();

          if (current > lastKnown) {
            logger.warn('Snapshot conflict detected - another tab may have modified this project', {
              projectId,
              lastKnown: this.#lastKnownSnapshotUpdatedAt,
              current: currentSnapshot.updated_at,
            });

            // Show warning to user but continue saving (last write wins)
            this.actionAlert.set({
              type: 'warning',
              title: 'Snapshot Conflict',
              description:
                'Another browser tab may have modified this project. Your changes will overwrite the previous save.',
              content: '',
            });
          }
        }
      } catch (error) {
        // Non-fatal - continue with save
        logger.debug('Failed to check for snapshot conflicts', { error });
      }
    }

    // Save to database
    const response = await fetch(`/api/projects/${projectId}/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: filesToSave,
        summary: `Auto-snapshot (${fileCount} files)`,
      }),
    });

    if (!response.ok) {
      const error = (await response.json()) as { error?: string };
      throw new Error(error.error || 'Failed to save snapshot');
    }

    // Update our known snapshot timestamp after successful save
    const savedSnapshot = (await response.json()) as { updated_at?: string };

    if (savedSnapshot.updated_at) {
      this.#lastKnownSnapshotUpdatedAt = savedSnapshot.updated_at;
    }

    logger.info('Snapshot saved successfully', { projectId, fileCount });
  }

  /**
   * Populate the local editor file store from the database snapshot WITHOUT
   * uploading to the sandbox or starting a dev server.
   *
   * Used during smart reconnection: when the sandbox is already running,
   * we only need the editor to have the files — no need to re-upload.
   */
  async #loadSnapshotIntoFileStore(): Promise<boolean> {
    const projectId = this.#currentProjectId;

    if (!projectId) {
      return false;
    }

    try {
      const response = await fetch(`/api/projects/${projectId}/snapshot`);

      if (!response.ok) {
        if (response.status === 404) {
          logger.info('No snapshot found for project (loadSnapshotIntoFileStore)', { projectId });
        }

        return false;
      }

      const snapshot = (await response.json()) as {
        files: Record<string, { content: string; isBinary: boolean; type?: string }>;
        updated_at: string;
      };

      if (!snapshot.files || Object.keys(snapshot.files).length === 0) {
        return false;
      }

      this.#lastKnownSnapshotUpdatedAt = snapshot.updated_at;
      this.#sessionStartedAt = Date.now();

      // Build file map with parent directories for file-tree UI
      const fileMap: Record<
        string,
        { type: 'file'; content: string; isBinary: boolean; isLocked: boolean } | { type: 'folder' }
      > = {};

      for (const [filePath, fileData] of Object.entries(snapshot.files)) {
        const parts = filePath.split('/');

        for (let i = 1; i < parts.length; i++) {
          const dirPath = parts.slice(0, i).join('/');

          if (!fileMap[dirPath]) {
            fileMap[dirPath] = { type: 'folder' };
          }
        }

        if (fileData.type === 'folder' || (fileData.content === '' && !filePath.includes('.'))) {
          if (!fileMap[filePath]) {
            fileMap[filePath] = { type: 'folder' };
          }
        } else {
          fileMap[filePath] = { type: 'file', content: fileData.content, isBinary: fileData.isBinary, isLocked: false };
        }
      }

      this.#filesStore.files.set(fileMap);
      logger.info('File store populated from snapshot (skip-upload path)', {
        projectId,
        fileCount: Object.keys(snapshot.files).length,
      });

      return true;
    } catch (error) {
      logger.error('Failed to load snapshot into file store', { error, projectId });
      return false;
    }
  }

  /**
   * Restore files from the database snapshot.
   * Called when creating a new sandbox to restore previous state.
   */
  async restoreFromDatabaseSnapshot(): Promise<boolean> {
    console.log('🔥 restoreFromDatabaseSnapshot CALLED');

    const projectId = this.#currentProjectId;

    if (!projectId) {
      console.log('🔥 restoreFromDatabaseSnapshot EARLY EXIT: no projectId');
      logger.warn('No active project to restore snapshot for');

      return false;
    }

    console.log('🔥 restoreFromDatabaseSnapshot: proceeding with projectId:', projectId);
    logger.info('Restoring from database snapshot', { projectId });
    this.loadingStatus.set('Restoring Files...');

    // Declare here to be accessible in finally block
    let savedFileSyncManager: FileSyncManager | null = null;

    try {
      const response = await fetch(`/api/projects/${projectId}/snapshot`);

      if (!response.ok) {
        if (response.status === 404) {
          logger.info('No snapshot found for project', { projectId });
          return false;
        }

        throw new Error('Failed to fetch snapshot');
      }

      const snapshot = (await response.json()) as {
        files: Record<string, { content: string; isBinary: boolean; type?: string }>;
        updated_at: string;
      };

      if (!snapshot.files || Object.keys(snapshot.files).length === 0) {
        logger.info('Snapshot is empty', { projectId });
        return false;
      }

      // Track snapshot timestamp for conflict detection
      this.#lastKnownSnapshotUpdatedAt = snapshot.updated_at;
      this.#sessionStartedAt = Date.now();

      // Restore files to the file store
      const fileCount = Object.keys(snapshot.files).length;
      logger.info(`Restoring ${fileCount} files from snapshot`, { projectId, snapshotUpdatedAt: snapshot.updated_at });

      // DEBUG: Log state before any operations
      console.log('[DEBUG restoreFromDatabaseSnapshot] Starting restore:', {
        projectId,
        fileCount,
        hasSandboxProvider: !!this.#sandboxProvider,
        hasFileSyncManager: !!this.#fileSyncManager,
      });

      // Isolate FileSyncManager to prevent micro-batch uploads during restore
      savedFileSyncManager = this.#fileSyncManager;

      if (this.#fileSyncManager) {
        console.log('[DEBUG restoreFromDatabaseSnapshot] Flushing and disabling FileSyncManager');
        await this.#fileSyncManager.flushWrites();
        this.#fileSyncManager = null;
        this.#filesStore.setFileSyncManager(null);
      }

      /*
       * Populate the file store directly — bypasses createFile which awaits
       * WebContainer boot and is unnecessary when using a Vercel sandbox.
       * Build parent-folder entries so the file-tree UI renders correctly.
       */
      const fileMap: Record<
        string,
        { type: 'file'; content: string; isBinary: boolean; isLocked: boolean } | { type: 'folder' }
      > = {};

      for (const [filePath, fileData] of Object.entries(snapshot.files)) {
        // Ensure every ancestor directory exists in the map
        const parts = filePath.split('/');

        for (let i = 1; i < parts.length; i++) {
          const dirPath = parts.slice(0, i).join('/');

          if (!fileMap[dirPath]) {
            fileMap[dirPath] = { type: 'folder' };
          }
        }

        /*
         * Some snapshots store folders as { type: 'folder' } or as { type: 'file', content: '' }
         * Treat both as folders — don't overwrite a folder entry with a fake file entry
         */
        if (fileData.type === 'folder' || (fileData.content === '' && !filePath.includes('.'))) {
          if (!fileMap[filePath]) {
            fileMap[filePath] = { type: 'folder' };
          }
        } else {
          fileMap[filePath] = { type: 'file', content: fileData.content, isBinary: fileData.isBinary, isLocked: false };
        }
      }

      this.#filesStore.files.set(fileMap);
      logger.info('File store populated from snapshot', { projectId, fileCount });

      // DEBUG: Log provider state before upload
      console.log('[DEBUG restoreFromDatabaseSnapshot] Provider state:', {
        hasSandboxProvider: !!this.#sandboxProvider,
        providerType: this.#sandboxProvider?.type,
        providerStatus: this.#sandboxProvider?.status,
        sandboxId: this.#sandboxProvider?.sandboxId,
        hasFileSyncManager: !!this.#fileSyncManager,
      });

      // Check if sandbox has enough time remaining for the upload + install + dev start (~3 min)
      if (this.#sandboxProvider?.timeoutRemaining !== null && this.#sandboxProvider?.timeoutRemaining !== undefined) {
        const timeRemaining = this.#sandboxProvider.timeoutRemaining;
        const MIN_REQUIRED_MS = 3 * 60 * 1000; // 3 minutes

        if (timeRemaining < MIN_REQUIRED_MS) {
          logger.warn('Sandbox has insufficient time remaining, extending timeout', {
            timeRemainingMs: timeRemaining,
            minRequiredMs: MIN_REQUIRED_MS,
          });

          try {
            await this.#sandboxProvider.extendTimeout?.(5 * 60 * 1000);
            logger.info('Sandbox timeout extended');
          } catch (extendError) {
            logger.warn('Failed to extend sandbox timeout, proceeding anyway', { error: extendError });
          }
        }
      }

      // Write all files to sandbox in chunked batches (Vercel has 4MB limit)
      if (this.#sandboxProvider) {
        // Prepare files in API-ready format (bypass provider to avoid Buffer issues)
        const apiFiles = Object.entries(snapshot.files)
          .filter(([filePath, fileData]) => {
            // Skip invalid entries
            if (!fileData || typeof fileData.content !== 'string') {
              console.warn('[restoreFromDatabaseSnapshot] Skipping invalid file entry:', fileData);
              return false;
            }

            /*
             * Skip folder entries — some snapshots store folders as { type: 'folder' }
             * or as { type: 'file', content: '' } for directory paths (no file extension).
             * Uploading these to Vercel SDK causes 400 errors because the SDK tries
             * to write a file where a directory already exists.
             */
            if (fileData.type === 'folder') {
              return false;
            }

            if (fileData.content === '' && !filePath.includes('.')) {
              logger.info('Skipping directory-like entry with empty content', { filePath });
              return false;
            }

            return true;
          })
          .map(([filePath, fileData]) => {
            if (fileData.isBinary) {
              // Binary files: content is already base64, use as-is
              return {
                path: filePath,
                content: fileData.content,
                encoding: 'base64' as const,
                size: atob(fileData.content).length, // Decode to get actual size
              };
            } else {
              // Text files: content is UTF-8 string, send as utf8 (schema expects 'utf8' not 'utf-8')
              return {
                path: filePath,
                content: fileData.content,
                encoding: 'utf8' as const,
                size: new TextEncoder().encode(fileData.content).length,
              };
            }
          });

        console.log('[DEBUG restoreFromDatabaseSnapshot] Prepared files:', {
          total: apiFiles.length,
          sample: apiFiles[0]
            ? {
                path: apiFiles[0].path,
                encoding: apiFiles[0].encoding,
                hasContent: !!apiFiles[0].content,
                contentType: typeof apiFiles[0].content,
                size: apiFiles[0].size,
              }
            : null,
        });

        const chunks = createChunksStrict(apiFiles, 3 * 1024 * 1024);

        this.loadingStatus.set(`Syncing to Sandbox (v3 - Fresh, ${chunks.length} batches)...`);

        console.log('[DEBUG restoreFromDatabaseSnapshot] Starting chunked upload:', {
          totalFiles: apiFiles.length,
          chunkCount: chunks.length,
          firstChunkFiles: chunks[0]?.length,
        });

        // Upload chunks sequentially via API route (bypasses Buffer issues)
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const chunkSize = chunk.reduce((sum, f) => sum + ((f as any).size || 0), 0);

          console.log(
            `[DEBUG restoreFromDatabaseSnapshot] Uploading chunk ${i + 1}/${chunks.length} (${chunk.length} files, ~${(chunkSize / 1024 / 1024).toFixed(4)}MB)`,
          );

          try {
            // Call API directly instead of provider.writeFiles() to avoid Buffer issues
            const requestBody = {
              projectId,
              sandboxId: this.#sandboxProvider.sandboxId,
              files: chunk.map((f) => ({
                path: f.path,
                content: f.content,
                encoding: f.encoding,
              })),
            };

            console.log('[DEBUG] Request body sample:', {
              projectId: requestBody.projectId,
              sandboxId: requestBody.sandboxId,
              fileCount: requestBody.files.length,
              firstFile: requestBody.files[0]
                ? {
                    path: requestBody.files[0].path,
                    encoding: requestBody.files[0].encoding,
                    contentLength: String(requestBody.files[0].content).length,
                    contentPreview: String(requestBody.files[0].content).substring(0, 50),
                  }
                : null,
            });

            const response = await fetch('/api/sandbox/files', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
              const errorData = (await response.json().catch(() => ({}))) as {
                error?: string;
                code?: string;
                details?: string;
                shouldRecreate?: boolean;
              };
              console.error('[restoreFromDatabaseSnapshot] Upload error details:', {
                status: response.status,
                code: errorData.code,
                error: errorData.error,
                details: errorData.details,
              });

              // If sandbox expired during upload, show notification (no auto-recreation)
              if (response.status === 410 || errorData.code === 'SANDBOX_EXPIRED') {
                logger.info('Sandbox expired during upload — showing notification');
                throw new Error('Preview session expired. Click Restart to continue.');
              }

              throw new Error(
                errorData.details || errorData.error || `HTTP ${response.status}: ${response.statusText}`,
              );
            }

            console.log(`[DEBUG restoreFromDatabaseSnapshot] Chunk ${i + 1}/${chunks.length} SUCCESS`);

            /*
             * Short pause between chunks to avoid burst rate-limiting.
             * 200ms is enough to let the sandbox flush writes without wasting time.
             */
            if (i < chunks.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          } catch (writeError) {
            console.error(`[DEBUG restoreFromDatabaseSnapshot] Chunk ${i + 1}/${chunks.length} FAILED:`, writeError);
            throw writeError;
          }
        }

        logger.info('Chunked file upload complete', { projectId, fileCount, chunks: chunks.length });
        console.log('[DEBUG restoreFromDatabaseSnapshot] All chunks uploaded successfully');

        // Verify upload by counting files in sandbox
        console.log('[DEBUG restoreFromDatabaseSnapshot] Verifying upload with find command');

        try {
          const findResult = await this.#sandboxProvider.runCommand('find', ['.', '-type', 'f']);
          const uploadedFileCount = findResult.stdout.split('\n').filter((line) => line.trim()).length;
          console.log(
            '[DEBUG restoreFromDatabaseSnapshot] Files in sandbox:',
            uploadedFileCount,
            'Expected:',
            apiFiles.length,
          );
        } catch (findError) {
          console.warn('[DEBUG restoreFromDatabaseSnapshot] find command failed:', findError);
        }

        // Patch vite.config.ts to allow Vercel sandbox hosts (before starting dev server)
        console.log('[DEBUG restoreFromDatabaseSnapshot] Patching vite.config.ts for Vercel Sandbox...');
        await this.#patchViteConfigForVercel();

        // Fire-and-forget: install deps + start dev server
        console.log('[DEBUG restoreFromDatabaseSnapshot] Calling #autoStartDevServer');
        this.loadingStatus.set('Starting Preview...');
        await this.#autoStartDevServer(snapshot.files);
      } else {
        console.warn('[DEBUG restoreFromDatabaseSnapshot] SKIPPED upload: sandboxProvider is null');
      }

      logger.info('Snapshot restored successfully', { projectId, fileCount });

      return true;
    } catch (error) {
      logger.error('Failed to restore from snapshot', { error, projectId });
      this.loadingStatus.set(null);

      this.actionAlert.set({
        type: 'error',
        title: 'Restore Failed',
        description: 'Failed to restore files from snapshot. Some files may be missing.',
        content: error instanceof Error ? error.message : String(error),
      });

      return false;
    } finally {
      // ALWAYS restore FileSyncManager, even if restore fails
      if (savedFileSyncManager) {
        this.#fileSyncManager = savedFileSyncManager;
        this.#filesStore.setFileSyncManager(savedFileSyncManager);
        console.log('[DEBUG restoreFromDatabaseSnapshot] FileSyncManager restored (in finally)');
      }
    }
  }

  /**
   * Parse package.json from snapshot files, run npm install, then fire-and-forget
   * the dev server. Vite projects get `-- --host` so the server binds to 0.0.0.0
   * (required for Vercel Sandbox port proxying).
   */
  async #autoStartDevServer(files: Record<string, { content: string; isBinary: boolean }>): Promise<void> {
    console.log('[DEBUG #autoStartDevServer] Starting auto-start process');

    const provider = this.#sandboxProvider;

    if (!provider) {
      console.warn('[DEBUG #autoStartDevServer] No provider available');
      return;
    }

    console.log('[DEBUG #autoStartDevServer] Provider available:', { type: provider.type, status: provider.status });

    const pkgRaw = files['package.json'];

    if (!pkgRaw) {
      logger.warn('[autoStartDevServer] No package.json in snapshot – skipping auto-start');
      console.warn('[DEBUG #autoStartDevServer] No package.json found');

      return;
    }

    console.log('[DEBUG #autoStartDevServer] Found package.json');

    let pkg: { scripts?: Record<string, string> };

    try {
      pkg = JSON.parse(pkgRaw.content);
    } catch {
      logger.warn('[autoStartDevServer] Failed to parse package.json – skipping auto-start');
      return;
    }

    const scripts = pkg.scripts || {};

    // Pick the best run script: dev > start
    const scriptName = scripts.dev ? 'dev' : scripts.start ? 'start' : null;

    if (!scriptName) {
      logger.warn('[autoStartDevServer] No dev or start script found – skipping auto-start');
      return;
    }

    logger.info(`[autoStartDevServer] Running npm install then npm run ${scriptName}`);
    console.log('[DEBUG #autoStartDevServer] About to run npm install with sandbox:', {
      sandboxId: provider.sandboxId,
      providerType: provider.type,
      providerStatus: provider.status,
    });

    try {
      /*
       * Await install so dependencies are available before starting the server
       * Use retry wrapper to handle sandbox expiration during long-running install
       */
      console.log('[DEBUG #autoStartDevServer] Calling #runCommandWithRetry for npm install...');

      // First check if package.json exists and where we are
      const pwdResult = await provider.runCommand('pwd', []);
      console.log('[DEBUG #autoStartDevServer] Current directory:', pwdResult.stdout);

      const lsResult = await provider.runCommand('ls', ['-la']);
      console.log('[DEBUG #autoStartDevServer] Directory contents:', lsResult.stdout);

      const installResult = await this.#runCommandWithRetry('npm', ['install', '--no-audit', '--no-fund']);
      console.log('[DEBUG #autoStartDevServer] npm install completed:', {
        exitCode: installResult.exitCode,
        stdout: installResult.stdout?.substring(0, 500),
        stderr: installResult.stderr?.substring(0, 500),
      });

      if (installResult.exitCode !== 0) {
        logger.error('[autoStartDevServer] npm install failed', {
          exitCode: installResult.exitCode,
          stdout: installResult.stdout,
          stderr: installResult.stderr,
        });
        console.error('[DEBUG #autoStartDevServer] npm install failed:', {
          exitCode: installResult.exitCode,
          stdout: installResult.stdout,
          stderr: installResult.stderr,
        });

        return;
      }

      console.log('[DEBUG #autoStartDevServer] npm install succeeded');

      logger.info('[autoStartDevServer] npm install succeeded, starting server…');
      console.log('[DEBUG #autoStartDevServer] npm install succeeded, starting dev server');

      /*
       * Determine if this is a Vite project – if so, append --host so the dev
       * server binds to 0.0.0.0 (needed for Vercel Sandbox port proxy).
       */
      const isVite = (scripts[scriptName] || '').includes('vite');
      const devArgs = isVite ? ['-c', `npm run ${scriptName} -- --host`] : ['-c', `npm run ${scriptName}`];

      console.log('[DEBUG #autoStartDevServer] Starting dev server:', { isVite, scriptName, devArgs });

      /*
       * Fire-and-forget: do NOT await – dev servers run indefinitely.
       * The preview polling in Preview.tsx will detect when the port is ready.
       * NOTE: Browser console errors (runtime errors) are NOT captured here.
       * They occur in the iframe and require a different mechanism to capture.
       */

      // Set up promise that resolves when dev server is ready
      this.#devServerStarting = true;

      let resolveDevServerReady: () => void;
      this.#devServerReadyPromise = new Promise((resolve) => {
        resolveDevServerReady = resolve;
      });

      provider.runCommand('sh', devArgs).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        const is410 = msg.includes('410') || msg.includes('SANDBOX_EXPIRED');

        if (is410) {
          // Sandbox expired — show notification, user must click Restart (no auto-recreation)
          logger.info('Dev server: sandbox expired — showing notification');
          this.actionAlert.set({
            type: 'warning',
            title: 'Session Expired',
            description: 'Your preview session has ended. Click Restart to continue.',
            content: '',
          });
        } else if (!is410) {
          logger.error('Dev server command failed unexpectedly', { error: msg });
        }

        // Mark dev server as no longer starting (even on error)
        this.#devServerStarting = false;
        resolveDevServerReady!();
      });
      console.log('[DEBUG #autoStartDevServer] Dev server command fired (fire-and-forget)');

      // Poll for dev server readiness
      this.#pollDevServerReady(provider, resolveDevServerReady!);

      // NOW register previews — dev server is starting, so the iframe can begin polling
      const previewUrls = provider.getPreviewUrls();

      for (const [port, url] of previewUrls) {
        logger.info('Registering preview after dev server start', { port, url });
        this.#previewsStore.registerPreview(port, url, 'vercel');
      }
    } catch (error) {
      const errorDetails = {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'Unknown',
        stack: error instanceof Error ? error.stack : undefined,
        raw: error,
      };
      logger.error('[autoStartDevServer] Error during auto-start', { error: errorDetails });
      console.error('[DEBUG #autoStartDevServer] Error during auto-start:', errorDetails);
    }
  }

  /**
   * Poll for dev server readiness by checking if the preview URL responds.
   * Resolves the promise when the server is ready or after max attempts.
   */
  async #pollDevServerReady(provider: SandboxProvider, resolve: () => void): Promise<void> {
    const previewUrls = provider.getPreviewUrls();
    const firstUrl = previewUrls.values().next().value as string | undefined;

    if (!firstUrl) {
      logger.warn('[pollDevServerReady] No preview URL available');
      this.#devServerStarting = false;
      resolve();

      return;
    }

    const maxAttempts = 60; // 60 attempts * 1s = 60s max wait
    let attempts = 0;

    const checkReady = async () => {
      attempts++;

      try {
        const healthRes = await fetch('/api/sandbox/health', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: firstUrl }),
        });
        const healthData = (await healthRes.json()) as { ready?: boolean };

        if (healthData.ready) {
          logger.info('[pollDevServerReady] Dev server is ready');
          this.#devServerStarting = false;
          resolve();

          return;
        }
      } catch {
        // Health check failed, server not ready yet
      }

      if (attempts >= maxAttempts) {
        logger.warn('[pollDevServerReady] Dev server readiness check timed out');
        this.#devServerStarting = false;
        resolve();

        return;
      }

      // Check again in 1 second
      setTimeout(checkReady, 1000);
    };

    // Start polling
    checkReady();
  }

  /**
   * Wait for the dev server to be ready before executing commands.
   * This prevents LLM commands from running before the dev server is up.
   */
  async waitForDevServerReady(): Promise<void> {
    if (!this.#devServerStarting || !this.#devServerReadyPromise) {
      return; // Dev server not starting, no need to wait
    }

    logger.debug('[waitForDevServerReady] Waiting for dev server to be ready...');
    await this.#devServerReadyPromise;
    logger.debug('[waitForDevServerReady] Dev server is ready');
  }

  /**
   * Automatically patch vite.config.ts to allow all hosts for Vercel Sandbox.
   * This fixes CORS issues when the sandbox is accessed via Vercel's proxy URL.
   */
  async #patchViteConfigForVercel(): Promise<void> {
    const provider = this.#sandboxProvider;
    const projectId = this.#currentProjectId;

    if (!provider || !projectId) {
      console.log('[patchViteConfigForVercel] Skipping: no provider or projectId');
      return;
    }

    try {
      console.log('[patchViteConfigForVercel] Checking for vite.config file...');

      // Check for vite.config.ts or vite.config.js
      let configFileName: string | null = null;
      let configContent: string | null = null;

      for (const fileName of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs']) {
        try {
          const result = await provider.runCommand('cat', [fileName]);

          if (result.exitCode === 0) {
            configFileName = fileName;
            configContent = result.stdout;
            console.log(`[patchViteConfigForVercel] Found ${fileName}`);
            break;
          }
        } catch {
          // File doesn't exist, try next
        }
      }

      if (!configFileName || !configContent) {
        console.log('[patchViteConfigForVercel] No vite.config file found, skipping');
        return;
      }

      // Check if allowedHosts is already set
      if (configContent.includes('allowedHosts')) {
        console.log('[patchViteConfigForVercel] allowedHosts already configured');
        return;
      }

      // Modify the config to add allowedHosts
      let patchedContent = configContent;

      if (patchedContent.includes('server:')) {
        // Add allowedHosts to existing server config
        patchedContent = patchedContent.replace(/server:\s*{/g, 'server: {\n    allowedHosts: true,');
        console.log('[patchViteConfigForVercel] Added allowedHosts to existing server config');
      } else {
        // Add new server config after plugins
        if (patchedContent.includes('plugins:')) {
          patchedContent = patchedContent.replace(
            /plugins:\s*\[.*?\],/s,
            (match) => `${match}\n  server: {\n    host: '0.0.0.0',\n    allowedHosts: true,\n  },`,
          );
          console.log('[patchViteConfigForVercel] Added new server config with allowedHosts');
        }
      }

      // Upload the patched config via API
      const response = await fetch('/api/sandbox/files', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          sandboxId: provider.sandboxId,
          files: [
            {
              path: configFileName,
              content: patchedContent,
              encoding: 'utf8',
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to upload patched config: ${response.statusText}`);
      }

      logger.info('[patchViteConfigForVercel] Successfully patched vite.config', { fileName: configFileName });
      console.log('[patchViteConfigForVercel] ✅ Config patched and uploaded');
    } catch (error) {
      // Non-fatal - log and continue
      logger.warn('[patchViteConfigForVercel] Failed to patch config', { error });
      console.warn('[patchViteConfigForVercel] Error:', error);
    }
  }

  get previews() {
    return this.#previewsStore.previews;
  }

  get files() {
    return this.#filesStore.files;
  }

  get currentDocument(): ReadableAtom<EditorDocument | undefined> {
    return this.#editorStore.currentDocument;
  }

  get selectedFile(): ReadableAtom<string | undefined> {
    return this.#editorStore.selectedFile;
  }

  get firstArtifact(): ArtifactState | undefined {
    return this.#getArtifact(this.artifactIdList[0]);
  }

  get filesCount(): number {
    return this.#filesStore.filesCount;
  }

  get showTerminal() {
    return this.#terminalStore.showTerminal;
  }
  get boltTerminal() {
    return this.#terminalStore.boltTerminal;
  }
  get alert() {
    return this.actionAlert;
  }
  clearAlert() {
    this.actionAlert.set(undefined);
  }

  get SupabaseAlert() {
    return this.supabaseAlert;
  }

  clearSupabaseAlert() {
    this.supabaseAlert.set(undefined);
  }

  get DeployAlert() {
    return this.deployAlert;
  }

  clearDeployAlert() {
    this.deployAlert.set(undefined);
  }

  toggleTerminal(value?: boolean) {
    this.#terminalStore.toggleTerminal(value);
  }

  attachTerminal(terminal: ITerminal) {
    this.#terminalStore.attachTerminal(terminal);
  }
  attachBoltTerminal(terminal: ITerminal) {
    this.#terminalStore.attachBoltTerminal(terminal);
  }

  detachTerminal(terminal: ITerminal) {
    this.#terminalStore.detachTerminal(terminal);
  }

  onTerminalResize(cols: number, rows: number) {
    this.#terminalStore.onTerminalResize(cols, rows);
  }

  setDocuments(files: FileMap) {
    this.#editorStore.setDocuments(files);

    if (this.#filesStore.filesCount > 0 && this.currentDocument.get() === undefined) {
      // we find the first file and select it
      for (const [filePath, dirent] of Object.entries(files)) {
        if (dirent?.type === 'file') {
          this.setSelectedFile(filePath);
          break;
        }
      }
    }
  }

  setShowWorkbench(show: boolean) {
    this.showWorkbench.set(show);
  }

  setCurrentDocumentContent(newContent: string) {
    const filePath = this.currentDocument.get()?.filePath;

    if (!filePath) {
      return;
    }

    const originalContent = this.#filesStore.getFile(filePath)?.content;
    const unsavedChanges = originalContent !== undefined && originalContent !== newContent;

    this.#editorStore.updateFile(filePath, newContent);

    const currentDocument = this.currentDocument.get();

    if (currentDocument) {
      const previousUnsavedFiles = this.unsavedFiles.get();

      if (unsavedChanges && previousUnsavedFiles.has(currentDocument.filePath)) {
        return;
      }

      const newUnsavedFiles = new Set(previousUnsavedFiles);

      if (unsavedChanges) {
        newUnsavedFiles.add(currentDocument.filePath);
      } else {
        newUnsavedFiles.delete(currentDocument.filePath);
      }

      this.unsavedFiles.set(newUnsavedFiles);
    }
  }

  setCurrentDocumentScrollPosition(position: ScrollPosition) {
    const editorDocument = this.currentDocument.get();

    if (!editorDocument) {
      return;
    }

    const { filePath } = editorDocument;

    this.#editorStore.updateScrollPosition(filePath, position);
  }

  setSelectedFile(filePath: string | undefined) {
    this.#editorStore.setSelectedFile(filePath);
  }

  async saveFile(filePath: string, content?: string) {
    const documents = this.#editorStore.documents.get();
    const document = documents[filePath];

    // If document exists in editorStore, use its value
    if (document !== undefined) {
      /*
       * For scoped locks, we would need to implement diff checking here
       * to determine if the user is modifying existing code or just adding new code
       * This is a more complex feature that would be implemented in a future update
       */

      await this.#filesStore.saveFile(filePath, document.value);

      const newUnsavedFiles = new Set(this.unsavedFiles.get());
      newUnsavedFiles.delete(filePath);
      this.unsavedFiles.set(newUnsavedFiles);

      // Record activity for timeout management
      this.recordActivity('file_write');

      return;
    }

    // If content is provided (from LLM action), save it directly to filesStore
    if (content !== undefined) {
      await this.#filesStore.saveFile(filePath, content);

      // Record activity for timeout management
      this.recordActivity('file_write');

      return;
    }

    // No content available from editorStore or parameter, cannot save
    logger.warn('Cannot save file: document not found in editor and no content provided', { filePath });
  }

  async saveCurrentDocument() {
    const currentDocument = this.currentDocument.get();

    if (currentDocument === undefined) {
      return;
    }

    await this.saveFile(currentDocument.filePath);
  }

  resetCurrentDocument() {
    const currentDocument = this.currentDocument.get();

    if (currentDocument === undefined) {
      return;
    }

    const { filePath } = currentDocument;
    const file = this.#filesStore.getFile(filePath);

    if (!file) {
      return;
    }

    this.setCurrentDocumentContent(file.content);
  }

  async saveAllFiles() {
    for (const filePath of this.unsavedFiles.get()) {
      await this.saveFile(filePath);
    }
  }

  getFileModifcations() {
    return this.#filesStore.getFileModifications();
  }

  getModifiedFiles() {
    return this.#filesStore.getModifiedFiles();
  }

  resetAllFileModifications() {
    this.#filesStore.resetFileModifications();
  }

  /**
   * Get paths of all files modified in the current session.
   * Used for context selection to boost recently edited files.
   * @returns Array of absolute file paths that have been modified
   */
  getModifiedFilePaths(): string[] {
    return this.#filesStore.getModifiedFilePaths();
  }

  /**
   * Lock a file to prevent edits
   * @param filePath Path to the file to lock
   * @returns True if the file was successfully locked
   */
  lockFile(filePath: string) {
    return this.#filesStore.lockFile(filePath);
  }

  /**
   * Lock a folder and all its contents to prevent edits
   * @param folderPath Path to the folder to lock
   * @returns True if the folder was successfully locked
   */
  lockFolder(folderPath: string) {
    return this.#filesStore.lockFolder(folderPath);
  }

  /**
   * Unlock a file to allow edits
   * @param filePath Path to the file to unlock
   * @returns True if the file was successfully unlocked
   */
  unlockFile(filePath: string) {
    return this.#filesStore.unlockFile(filePath);
  }

  /**
   * Unlock a folder and all its contents to allow edits
   * @param folderPath Path to the folder to unlock
   * @returns True if the folder was successfully unlocked
   */
  unlockFolder(folderPath: string) {
    return this.#filesStore.unlockFolder(folderPath);
  }

  /**
   * Check if a file is locked
   * @param filePath Path to the file to check
   * @returns Object with locked status, lock mode, and what caused the lock
   */
  isFileLocked(filePath: string) {
    return this.#filesStore.isFileLocked(filePath);
  }

  /**
   * Check if a folder is locked
   * @param folderPath Path to the folder to check
   * @returns Object with locked status, lock mode, and what caused the lock
   */
  isFolderLocked(folderPath: string) {
    return this.#filesStore.isFolderLocked(folderPath);
  }

  async createFile(filePath: string, content: string | Uint8Array = '') {
    try {
      const success = await this.#filesStore.saveFile(filePath, content);

      if (success) {
        this.setSelectedFile(filePath);

        /*
         * For empty files, we need to ensure they're not marked as unsaved
         * Only check for empty string, not empty Uint8Array
         */
        if (typeof content === 'string' && content === '') {
          const newUnsavedFiles = new Set(this.unsavedFiles.get());
          newUnsavedFiles.delete(filePath);
          this.unsavedFiles.set(newUnsavedFiles);
        }
      }

      return success;
    } catch (error) {
      console.error('Failed to create file:', error);
      throw error;
    }
  }

  async createFolder(folderPath: string) {
    try {
      return await this.#filesStore.createFolder(folderPath);
    } catch (error) {
      console.error('Failed to create folder:', error);
      throw error;
    }
  }

  async deleteFile(filePath: string) {
    try {
      const currentDocument = this.currentDocument.get();
      const isCurrentFile = currentDocument?.filePath === filePath;

      const success = await this.#filesStore.deleteFile(filePath);

      if (success) {
        const newUnsavedFiles = new Set(this.unsavedFiles.get());

        if (newUnsavedFiles.has(filePath)) {
          newUnsavedFiles.delete(filePath);
          this.unsavedFiles.set(newUnsavedFiles);
        }

        if (isCurrentFile) {
          const files = this.files.get();
          let nextFile: string | undefined = undefined;

          for (const [path, dirent] of Object.entries(files)) {
            if (dirent?.type === 'file') {
              nextFile = path;
              break;
            }
          }

          this.setSelectedFile(nextFile);
        }
      }

      return success;
    } catch (error) {
      console.error('Failed to delete file:', error);
      throw error;
    }
  }

  async deleteFolder(folderPath: string) {
    try {
      const currentDocument = this.currentDocument.get();
      const isInCurrentFolder = currentDocument?.filePath?.startsWith(folderPath + '/');

      const success = await this.#filesStore.deleteFolder(folderPath);

      if (success) {
        const unsavedFiles = this.unsavedFiles.get();
        const newUnsavedFiles = new Set<string>();

        for (const file of unsavedFiles) {
          if (!file.startsWith(folderPath + '/')) {
            newUnsavedFiles.add(file);
          }
        }

        if (newUnsavedFiles.size !== unsavedFiles.size) {
          this.unsavedFiles.set(newUnsavedFiles);
        }

        if (isInCurrentFolder) {
          const files = this.files.get();
          let nextFile: string | undefined = undefined;

          for (const [path, dirent] of Object.entries(files)) {
            if (dirent?.type === 'file') {
              nextFile = path;
              break;
            }
          }

          this.setSelectedFile(nextFile);
        }
      }

      return success;
    } catch (error) {
      console.error('Failed to delete folder:', error);
      throw error;
    }
  }

  abortAllActions() {
    // TODO: what do we wanna do and how do we wanna recover from this?
  }

  setReloadedMessages(messages: string[]) {
    this.#reloadedMessages = new Set(messages);
  }

  addArtifact({ messageId, title, id, type }: ArtifactCallbackData) {
    const artifact = this.#getArtifact(id);

    /*
     * If artifact exists but belongs to a different message, we need to replace it.
     * This handles the case where HMR preserves artifacts from previous tests,
     * or when the LLM reuses the same artifact ID for a different message.
     */
    if (artifact && artifact.messageId !== messageId) {
      logger.debug('Replacing artifact with same ID from different message', {
        artifactId: id,
        oldMessageId: artifact.messageId,
        newMessageId: messageId,
      });

      // Fall through to create a new artifact
    } else if (artifact) {
      // Artifact exists and belongs to the same message, skip
      return;
    }

    if (!this.artifactIdList.includes(id)) {
      this.artifactIdList.push(id);
    }

    // Log provider state when creating artifact
    console.log('[WorkbenchStore] addArtifact - creating ActionRunner', {
      artifactId: id,
      messageId,
      hasProvider: !!this.#sandboxProvider,
      providerType: this.#sandboxProvider?.type,
      providerStatus: this.#sandboxProvider?.status,
      sandboxId: this.#sandboxProvider?.sandboxId,
    });

    this.artifacts.setKey(id, {
      id,
      title,
      closed: false,
      type,
      messageId,
      runner: new ActionRunner(
        webcontainer,
        () => this.boltTerminal,
        (alert) => {
          if (this.#reloadedMessages.has(messageId)) {
            return;
          }

          this.actionAlert.set(alert);
        },
        (alert) => {
          if (this.#reloadedMessages.has(messageId)) {
            return;
          }

          this.supabaseAlert.set(alert);
        },
        (alert) => {
          if (this.#reloadedMessages.has(messageId)) {
            return;
          }

          this.deployAlert.set(alert);
        },
        (relativePath, timeout) => {
          this.#filesStore.markRecentlySaved(relativePath, timeout);
        },

        // onSandboxExpired - trigger auto-recovery when sandbox dies during command execution
        async () => {
          if (this.#isRecreating) {
            logger.warn('Sandbox recreation already in progress, waiting...');

            // Wait for existing recreation to complete
            await new Promise((resolve) => {
              const checkInterval = setInterval(() => {
                if (!this.#isRecreating) {
                  clearInterval(checkInterval);
                  resolve(undefined);
                }
              }, 500);
            });

            return;
          }

          try {
            this.#isRecreating = true;
            this.loadingStatus.set('Sandbox session expired. Recreating...');
            await this.#recreateSandbox();

            // Wait for dev server to be ready before allowing commands
            logger.info('Waiting for dev server to be ready after auto-recovery...');
            await this.waitForDevServerReady();
            logger.info('Sandbox auto-recovery complete after command failure');
          } catch (recoveryError) {
            logger.error('Sandbox auto-recovery failed', { error: recoveryError });
            this.actionAlert.set({
              type: 'error',
              title: 'Session Recovery Failed',
              description: 'Could not restore your session. Please refresh the page to continue.',
              content: '',
            });
            throw recoveryError;
          } finally {
            this.#isRecreating = false;
          }
        },
      ),
    });
  }

  updateArtifact({ artifactId }: ArtifactCallbackData, state: Partial<ArtifactUpdateState>) {
    if (!artifactId) {
      return;
    }

    const artifact = this.#getArtifact(artifactId);

    if (!artifact) {
      return;
    }

    this.artifacts.setKey(artifactId, { ...artifact, ...state });
  }
  addAction(data: ActionCallbackData) {
    // Skip adding actions for reloaded messages entirely
    if (this.#reloadedMessages.has(data.messageId)) {
      logger.debug('[RELOADED_SKIP] Skipping addAction for reloaded message', {
        messageId: data.messageId,
        actionType: data.action.type,
      });
      return;
    }

    const artifact = this.#getArtifact(data.artifactId);

    /*
     * For bundled artifacts, add actions synchronously and mark as complete
     * since bundled artifacts are just for display (files are pre-loaded)
     */
    if (artifact?.type === 'bundled') {
      // Skip bundled actions for reloaded messages too
      if (this.#reloadedMessages.has(data.messageId)) {
        logger.debug('[RELOADED_SKIP] Skipping bundled action for reloaded message', {
          messageId: data.messageId,
          actionType: data.action.type,
        });
        return;
      }

      artifact.runner.addAction(data);

      return;
    }

    this.addToExecutionQueue(() => this._addAction(data));
  }
  async _addAction(data: ActionCallbackData) {
    const { artifactId } = data;

    const artifact = this.#getArtifact(artifactId);

    if (!artifact) {
      unreachable('Artifact not found');
    }

    return artifact.runner.addAction(data);
  }

  runAction(data: ActionCallbackData, isStreaming: boolean = false) {
    logger.info('runAction called', {
      artifactId: data.artifactId,
      actionId: data.actionId,
      actionType: data.action.type,
      filePath: data.action.type === 'file' ? data.action.filePath : undefined,
      isStreaming,
      isReloadedMessage: this.#reloadedMessages.has(data.messageId),
    });

    // Skip ALL actions for reloaded messages to prevent re-execution of historical commands
    if (this.#reloadedMessages.has(data.messageId)) {
      logger.debug('[RELOADED_SKIP] Skipping action for reloaded message', {
        messageId: data.messageId,
        actionType: data.action.type,
      });
      return;
    }

    if (isStreaming) {
      this.actionStreamSampler(data, isStreaming);
    } else {
      const artifact = this.#getArtifact(data.artifactId);

      logger.debug('runAction artifact lookup', {
        artifactId: data.artifactId,
        artifactFound: !!artifact,
        artifactType: artifact?.type,
      });

      /*
       * For bundled artifacts, execute file actions directly without queue
       * This ensures files are actually written to webcontainer
       */
      if (artifact?.type === 'bundled') {
        this._runBundledAction(data);
        return;
      }

      this.addToExecutionQueue(() => this._runAction(data, isStreaming));
    }
  }

  async _runBundledAction(data: ActionCallbackData) {
    // Skip ALL actions for reloaded messages to prevent re-execution of historical commands
    if (this.#reloadedMessages.has(data.messageId)) {
      logger.debug('[RELOADED_SKIP] Skipping bundled action for reloaded message', {
        messageId: data.messageId,
        actionType: data.action.type,
      });
      return;
    }

    const artifact = this.#getArtifact(data.artifactId);

    if (!artifact) {
      return;
    }

    const actions = artifact.runner.actions.get();
    const action = actions[data.actionId];

    if (!action || action.executed) {
      return;
    }

    try {
      // For file actions, write to webcontainer and update editor
      if (data.action.type === 'file') {
        const wc = await webcontainer;
        const fullPath = path.join(wc.workdir, data.action.filePath);

        // Write file to webcontainer via runner (handles mkdir + writeFile)
        await artifact.runner.runAction(data, false);

        // Also update the editor store so files appear in editor
        this.#editorStore.updateFile(fullPath, data.action.content);
      } else {
        // For non-file actions, run through runner
        await artifact.runner.runAction(data, false);
      }
    } catch (error) {
      logger.error('Bundled action failed:', error);
    }
  }
  async _runAction(data: ActionCallbackData, isStreaming: boolean = false) {
    const { artifactId } = data;

    const artifact = this.#getArtifact(artifactId);

    if (!artifact) {
      logger.error('_runAction: Artifact not found', { artifactId });
      unreachable('Artifact not found');
    }

    const action = artifact.runner.actions.get()[data.actionId];

    if (!action || action.executed) {
      logger.debug('_runAction: Skipping - action not found or already executed', {
        artifactId,
        actionId: data.actionId,
        actionFound: !!action,
        executed: action?.executed,
      });
      return;
    }

    if (data.action.type === 'file') {
      const wc = await webcontainer;
      const fullPath = path.join(wc.workdir, data.action.filePath);

      logger.info('_runAction: Processing file action', {
        filePath: data.action.filePath,
        fullPath,
        isStreaming,
        contentLength: data.action.content?.length,
      });

      /*
       * For scoped locks, we would need to implement diff checking here
       * to determine if the AI is modifying existing code or just adding new code
       * This is a more complex feature that would be implemented in a future update
       */

      if (this.selectedFile.value !== fullPath) {
        this.setSelectedFile(fullPath);
      }

      if (this.currentView.value !== 'code') {
        this.currentView.set('code');
      }

      const doc = this.#editorStore.documents.get()[fullPath];

      if (!doc) {
        await artifact.runner.runAction(data, isStreaming);
      }

      this.#editorStore.updateFile(fullPath, data.action.content);

      if (!isStreaming && data.action.content) {
        logger.info('_runAction: Calling saveFile', { fullPath, contentLength: data.action.content.length });
        await this.saveFile(fullPath, data.action.content);
      }

      if (!isStreaming) {
        await artifact.runner.runAction(data);
        this.resetAllFileModifications();
      }
    } else {
      await artifact.runner.runAction(data);
    }
  }

  actionStreamSampler = createSampler(async (data: ActionCallbackData, isStreaming: boolean = false) => {
    return await this._runAction(data, isStreaming);
  }, 100); // TODO: remove this magic number to have it configurable

  #getArtifact(id: string) {
    const artifacts = this.artifacts.get();
    return artifacts[id];
  }

  async downloadZip() {
    const zip = new JSZip();
    const files = this.files.get();

    // Get the project name from the description input, or use a default name
    const projectName = (description.value ?? 'project').toLocaleLowerCase().split(' ').join('_');

    // Generate a simple 6-character hash based on the current timestamp
    const timestampHash = Date.now().toString(36).slice(-6);
    const uniqueProjectName = `${projectName}_${timestampHash}`;

    for (const [filePath, dirent] of Object.entries(files)) {
      if (dirent?.type === 'file' && !dirent.isBinary) {
        const relativePath = extractRelativePath(filePath);

        // split the path into segments
        const pathSegments = relativePath.split('/');

        // if there's more than one segment, we need to create folders
        if (pathSegments.length > 1) {
          let currentFolder = zip;

          for (let i = 0; i < pathSegments.length - 1; i++) {
            currentFolder = currentFolder.folder(pathSegments[i])!;
          }
          currentFolder.file(pathSegments[pathSegments.length - 1], dirent.content);
        } else {
          // if there's only one segment, it's a file in the root
          zip.file(relativePath, dirent.content);
        }
      }
    }

    // Generate the zip file and save it
    const content = await zip.generateAsync({ type: 'blob' });
    saveAs(content, `${uniqueProjectName}.zip`);
  }

  async syncFiles(targetHandle: FileSystemDirectoryHandle) {
    const files = this.files.get();
    const syncedFiles = [];

    for (const [filePath, dirent] of Object.entries(files)) {
      if (dirent?.type === 'file' && !dirent.isBinary) {
        const relativePath = extractRelativePath(filePath);
        const pathSegments = relativePath.split('/');
        let currentHandle = targetHandle;

        for (let i = 0; i < pathSegments.length - 1; i++) {
          currentHandle = await currentHandle.getDirectoryHandle(pathSegments[i], { create: true });
        }

        // create or get the file
        const fileHandle = await currentHandle.getFileHandle(pathSegments[pathSegments.length - 1], {
          create: true,
        });

        // write the file content
        const writable = await fileHandle.createWritable();
        await writable.write(dirent.content);
        await writable.close();

        syncedFiles.push(relativePath);
      }
    }

    return syncedFiles;
  }

  async pushToRepository(
    provider: 'github' | 'gitlab',
    repoName: string,
    commitMessage?: string,
    username?: string,
    token?: string,
    isPrivate: boolean = false,
    branchName: string = 'main',
  ) {
    try {
      const isGitHub = provider === 'github';
      const isGitLab = provider === 'gitlab';

      const authToken = token || Cookies.get(isGitHub ? 'githubToken' : 'gitlabToken');
      const owner = username || Cookies.get(isGitHub ? 'githubUsername' : 'gitlabUsername');

      if (!authToken || !owner) {
        throw new Error(`${provider} token or username is not set in cookies or provided.`);
      }

      const files = this.files.get();

      if (!files || Object.keys(files).length === 0) {
        throw new Error('No files found to push');
      }

      if (isGitHub) {
        // Initialize Octokit with the auth token
        const octokit = new Octokit({ auth: authToken });

        // Check if the repository already exists before creating it
        let repo: RestEndpointMethodTypes['repos']['get']['response']['data'];
        let visibilityJustChanged = false;

        try {
          const resp = await octokit.repos.get({ owner, repo: repoName });
          repo = resp.data;
          console.log('Repository already exists, using existing repo');

          // Check if we need to update visibility of existing repo
          if (repo.private !== isPrivate) {
            console.log(
              `Updating repository visibility from ${repo.private ? 'private' : 'public'} to ${isPrivate ? 'private' : 'public'}`,
            );

            try {
              // Update repository visibility using the update method
              const { data: updatedRepo } = await octokit.repos.update({
                owner,
                repo: repoName,
                private: isPrivate,
              });

              console.log('Repository visibility updated successfully');
              repo = updatedRepo;
              visibilityJustChanged = true;

              // Add a delay after changing visibility to allow GitHub to fully process the change
              console.log('Waiting for visibility change to propagate...');
              await new Promise((resolve) => setTimeout(resolve, 3000)); // 3 second delay
            } catch (visibilityError) {
              console.error('Failed to update repository visibility:', visibilityError);

              // Continue with push even if visibility update fails
            }
          }
        } catch (error) {
          if (error instanceof Error && 'status' in error && error.status === 404) {
            // Repository doesn't exist, so create a new one
            console.log(`Creating new repository with private=${isPrivate}`);

            // Create new repository with specified privacy setting
            const createRepoOptions = {
              name: repoName,
              private: isPrivate,
              auto_init: true,
            };

            console.log('Create repo options:', createRepoOptions);

            const { data: newRepo } = await octokit.repos.createForAuthenticatedUser(createRepoOptions);

            console.log('Repository created:', newRepo.html_url, 'Private:', newRepo.private);
            repo = newRepo;

            // Add a small delay after creating a repository to allow GitHub to fully initialize it
            console.log('Waiting for repository to initialize...');
            await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay
          } else {
            console.error('Cannot create repo:', error);
            throw error; // Some other error occurred
          }
        }

        // Get all files
        const files = this.files.get();

        if (!files || Object.keys(files).length === 0) {
          throw new Error('No files found to push');
        }

        // Function to push files with retry logic
        const pushFilesToRepo = async (attempt = 1): Promise<string> => {
          const maxAttempts = 3;

          try {
            console.log(`Pushing files to repository (attempt ${attempt}/${maxAttempts})...`);

            // Create blobs for each file
            const blobs = await Promise.all(
              Object.entries(files).map(async ([filePath, dirent]) => {
                if (dirent?.type === 'file' && dirent.content) {
                  const { data: blob } = await octokit.git.createBlob({
                    owner: repo.owner.login,
                    repo: repo.name,
                    content: Buffer.from(dirent.content).toString('base64'),
                    encoding: 'base64',
                  });
                  return { path: extractRelativePath(filePath), sha: blob.sha };
                }

                return null;
              }),
            );

            const validBlobs = blobs.filter(Boolean); // Filter out any undefined blobs

            if (validBlobs.length === 0) {
              throw new Error('No valid files to push');
            }

            // Refresh repository reference to ensure we have the latest data
            const repoRefresh = await octokit.repos.get({ owner, repo: repoName });
            repo = repoRefresh.data;

            // Get the latest commit SHA (assuming main branch, update dynamically if needed)
            const { data: ref } = await octokit.git.getRef({
              owner: repo.owner.login,
              repo: repo.name,
              ref: `heads/${repo.default_branch || 'main'}`, // Handle dynamic branch
            });
            const latestCommitSha = ref.object.sha;

            // Create a new tree
            const { data: newTree } = await octokit.git.createTree({
              owner: repo.owner.login,
              repo: repo.name,
              base_tree: latestCommitSha,
              tree: validBlobs.map((blob) => ({
                path: blob!.path,
                mode: '100644',
                type: 'blob',
                sha: blob!.sha,
              })),
            });

            // Create a new commit
            const { data: newCommit } = await octokit.git.createCommit({
              owner: repo.owner.login,
              repo: repo.name,
              message: commitMessage || 'Initial commit from your app',
              tree: newTree.sha,
              parents: [latestCommitSha],
            });

            // Update the reference
            await octokit.git.updateRef({
              owner: repo.owner.login,
              repo: repo.name,
              ref: `heads/${repo.default_branch || 'main'}`, // Handle dynamic branch
              sha: newCommit.sha,
            });

            console.log('Files successfully pushed to repository');

            return repo.html_url;
          } catch (error) {
            console.error(`Error during push attempt ${attempt}:`, error);

            // If we've just changed visibility and this is not our last attempt, wait and retry
            if ((visibilityJustChanged || attempt === 1) && attempt < maxAttempts) {
              const delayMs = attempt * 2000; // Increasing delay with each attempt
              console.log(`Waiting ${delayMs}ms before retry...`);
              await new Promise((resolve) => setTimeout(resolve, delayMs));

              return pushFilesToRepo(attempt + 1);
            }

            throw error; // Rethrow if we're out of attempts
          }
        };

        // Execute the push function with retry logic
        const repoUrl = await pushFilesToRepo();

        // Return the repository URL
        return repoUrl;
      }

      if (isGitLab) {
        const { GitLabApiService: gitLabApiServiceClass } = await import('~/lib/services/gitlabApiService');
        const gitLabApiService = new gitLabApiServiceClass(authToken, 'https://gitlab.com');

        // Check or create repo
        let repo = await gitLabApiService.getProject(owner, repoName);

        if (!repo) {
          repo = await gitLabApiService.createProject(repoName, isPrivate);
          await new Promise((r) => setTimeout(r, 2000)); // Wait for repo initialization
        }

        // Check if branch exists, create if not
        const branchRes = await gitLabApiService.getFile(repo.id, 'README.md', branchName).catch(() => null);

        if (!branchRes || !branchRes.ok) {
          // Create branch from default
          await gitLabApiService.createBranch(repo.id, branchName, repo.default_branch);
          await new Promise((r) => setTimeout(r, 1000));
        }

        const actions = Object.entries(files).reduce(
          (acc, [filePath, dirent]) => {
            if (dirent?.type === 'file' && dirent.content) {
              acc.push({
                action: 'create',
                file_path: extractRelativePath(filePath),
                content: dirent.content,
              });
            }

            return acc;
          },
          [] as { action: 'create' | 'update'; file_path: string; content: string }[],
        );

        // Check which files exist and update action accordingly
        for (const action of actions) {
          const fileCheck = await gitLabApiService.getFile(repo.id, action.file_path, branchName);

          if (fileCheck.ok) {
            action.action = 'update';
          }
        }

        // Commit all files
        await gitLabApiService.commitFiles(repo.id, {
          branch: branchName,
          commit_message: commitMessage || 'Commit multiple files',
          actions,
        });

        return repo.web_url;
      }

      // Should not reach here since we only handle GitHub and GitLab
      throw new Error(`Unsupported provider: ${provider}`);
    } catch (error) {
      console.error('Error pushing to repository:', error);
      throw error; // Rethrow the error for further handling
    }
  }
}

export const workbenchStore = new WorkbenchStore();
