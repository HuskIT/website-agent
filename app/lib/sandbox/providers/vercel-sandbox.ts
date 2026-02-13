/**
 * Vercel Sandbox Provider
 * Feature: 001-sandbox-providers
 *
 * Implements SandboxProvider interface using Vercel Sandbox API.
 * All operations are proxied through server-side API routes to protect credentials.
 */

import type {
  SandboxProvider,
  SandboxProviderType,
  SandboxStatus,
  SandboxConfig,
  CommandOptions,
  CommandOutput,
  CommandResult,
  SnapshotResult,
  FileChangeEvent,
  TerminalInterface,
  ShellProcess,
} from '~/lib/sandbox/types';
import type {
  CreateSandboxResponse,
  ReconnectSandboxResponse,
  GetSandboxStatusResponse,
  ExtendTimeoutResponse,
  CreateSnapshotResponse,
  RestoreSnapshotResponse,
  CommandSSEEvent,
} from '~/lib/sandbox/schemas';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('VercelSandboxProvider');

type StatusCallback = (status: SandboxStatus) => void;
type PreviewCallback = (port: number, url: string) => void;
type FileChangeCallback = (event: FileChangeEvent) => void;

/**
 * VercelSandboxProvider implements the SandboxProvider interface
 * using Vercel Sandbox cloud execution via server-side API proxy.
 */
export class VercelSandboxProvider implements SandboxProvider {
  readonly type: SandboxProviderType = 'vercel';

  private _status: SandboxStatus = 'disconnected';
  private _sandboxId: string | null = null;
  private _config: SandboxConfig | null = null;
  private _timeoutRemaining: number | null = null;
  private _statusCallbacks: Set<StatusCallback> = new Set();
  private _previewCallbacks: Set<PreviewCallback> = new Set();
  private _fileChangeCallbacks: Set<FileChangeCallback> = new Set();
  private _previewUrls: Map<number, string> = new Map();
  private _timeoutCheckInterval: NodeJS.Timeout | null = null;

  // Track sandbox creation time and extensions for accurate timeout calculation
  private _createdAt: Date | null = null;
  private _initialTimeout: number | null = null;
  private _totalExtensions: number = 0;

  // Resource usage tracking (T037)
  private _resourceMetrics = {
    cpuPercent: 0,
    memoryMB: 0,
    lastUpdated: 0,
  };

  get sandboxId(): string | null {
    return this._sandboxId;
  }

  get status(): SandboxStatus {
    return this._status;
  }

  get timeoutRemaining(): number | null {
    // Use server-provided timeout if available and we haven't started local tracking yet
    if (!this._createdAt || this._initialTimeout === null) {
      return this._timeoutRemaining;
    }

    // Calculate actual remaining time based on elapsed time since last sync
    const elapsed = Date.now() - this._createdAt.getTime();
    const remaining = this._initialTimeout - elapsed;

    return Math.max(0, remaining);
  }

  /**
   * Get current resource usage metrics (T037)
   */
  get resourceMetrics(): { cpuPercent: number; memoryMB: number; lastUpdated: number } {
    return { ...this._resourceMetrics };
  }

  /**
   * Connect to Vercel Sandbox (creates a new sandbox)
   */
  async connect(config: SandboxConfig): Promise<void> {
    this._config = config;
    this._setStatus('connecting');

    try {
      const response = await fetch('/api/sandbox/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: config.projectId,
          snapshotId: config.snapshotId,
          runtime: config.runtime,
          ports: config.ports,
          timeout: config.timeout,
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error?: string };
        throw new Error(errorData.error || 'Failed to create sandbox');
      }

      const data: CreateSandboxResponse = await response.json();

      this._sandboxId = data.sandboxId;
      this._timeoutRemaining = data.timeout;

      // Store creation time and initial timeout for accurate remaining time calculation
      this._createdAt = new Date(data.createdAt);
      this._initialTimeout = data.timeout;
      this._totalExtensions = 0;

      logger.info('Sandbox created', {
        sandboxId: data.sandboxId,
        createdAt: this._createdAt.toISOString(),
        initialTimeout: this._initialTimeout / 60000,
      });

      // Set up preview URLs
      for (const [port, url] of Object.entries(data.previewUrls)) {
        const portNum = parseInt(port, 10);
        this._previewUrls.set(portNum, url);
        this._previewCallbacks.forEach((cb) => cb(portNum, url));
      }

      // Start timeout tracking
      this._startTimeoutTracking();

      this._setStatus('connected');
    } catch (error) {
      this._setStatus('error');
      throw error;
    }
  }

  /**
   * Disconnect from sandbox (triggers auto-snapshot)
   */
  async disconnect(): Promise<void> {
    if (!this._sandboxId || !this._config) {
      this._setStatus('disconnected');
      return;
    }

    try {
      await fetch('/api/sandbox/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: this._config.projectId,
          sandboxId: this._sandboxId,
          createSnapshot: true,
        }),
      });
    } catch (error) {
      logger.error('Error stopping sandbox:', error);
    } finally {
      this._cleanup();
      this._setStatus('disconnected');
    }
  }

  /**
   * Reconnect to an existing sandbox session
   */
  async reconnect(sandboxId: string): Promise<boolean> {
    if (!this._config) {
      return false;
    }

    this._setStatus('reconnecting');

    try {
      const response = await fetch('/api/sandbox/reconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: this._config.projectId,
          sandboxId,
        }),
      });

      if (!response.ok) {
        this._setStatus('disconnected');
        return false;
      }

      const data: ReconnectSandboxResponse = await response.json();

      if (!data.success || data.status !== 'running') {
        this._setStatus('disconnected');
        return false;
      }

      this._sandboxId = data.sandboxId ?? sandboxId;
      this._timeoutRemaining = data.timeout ?? null;

      // Set up preview URLs
      if (data.previewUrls) {
        for (const [port, url] of Object.entries(data.previewUrls)) {
          const portNum = parseInt(port, 10);
          this._previewUrls.set(portNum, url);
          this._previewCallbacks.forEach((cb) => cb(portNum, url));
        }
      }

      this._startTimeoutTracking();
      this._setStatus('connected');

      return true;
    } catch (error) {
      logger.error('Error reconnecting to sandbox:', error);
      this._setStatus('disconnected');

      return false;
    }
  }

  /**
   * Set up the provider with an existing sandbox that was just restored.
   * This bypasses all API calls since the restore API already verified everything.
   */
  setupFromRestore(
    config: SandboxConfig,
    sandboxId: string,
    previewUrls: Record<number, string>,
    timeout: number,
  ): void {
    this._config = config;
    this._sandboxId = sandboxId;
    this._timeoutRemaining = timeout;

    // Set up preview URLs
    for (const [port, url] of Object.entries(previewUrls)) {
      const portNum = parseInt(port, 10);
      this._previewUrls.set(portNum, url);
      this._previewCallbacks.forEach((cb) => cb(portNum, url));
    }

    this._startTimeoutTracking();
    this._setStatus('connected');
  }

  /**
   * Subscribe to status changes
   */
  onStatusChange(callback: StatusCallback): () => void {
    this._statusCallbacks.add(callback);
    return () => this._statusCallbacks.delete(callback);
  }

  /*
   * -------------------------------------------------------------------------
   * File Operations
   * -------------------------------------------------------------------------
   */

  /**
   * Normalize file path for Vercel sandbox.
   * Vercel sandbox uses root as working directory (not /home/project).
   * Strips leading /home/project or /home/project/ from paths.
   */
  private _normalizePath(path: string): string {
    if (path.startsWith('/home/project/')) {
      return path.slice('/home/project/'.length);
    }

    if (path === '/home/project') {
      return '';
    }

    return path;
  }

  /**
   * Write a single file
   */
  async writeFile(path: string, content: string | Buffer): Promise<void> {
    await this.writeFiles([
      {
        path,
        content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'),
      },
    ]);
  }

  /**
   * Write multiple files (batch)
   */
  async writeFiles(files: Array<{ path: string; content: Buffer }>): Promise<void> {
    if (!this._sandboxId || !this._config) {
      throw new Error('Sandbox not connected');
    }

    const response = await fetch('/api/sandbox/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: this._config.projectId,
        sandboxId: this._sandboxId,
        files: files.map((f) => ({
          path: this._normalizePath(f.path),
          content: f.content.toString('base64'),
          encoding: 'base64',
        })),
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: string };
      throw new Error(errorData.error || 'Failed to write files');
    }

    /*
     * Don't emit file change events for local writes
     * The store already knows about these files (it initiated the write)
     * File change events should only be emitted for external changes (git pull, collaborative edit)
     */
  }

  /**
   * Read file contents as string
   */
  async readFile(path: string): Promise<string | null> {
    const buffer = await this.readFileBuffer(path);
    return buffer ? buffer.toString('utf-8') : null;
  }

  /**
   * Read file contents as buffer
   */
  async readFileBuffer(path: string): Promise<Buffer | null> {
    if (!this._sandboxId || !this._config) {
      throw new Error('Sandbox not connected');
    }

    const encodedPath = encodeURIComponent(this._normalizePath(path));
    const response = await fetch(
      `/api/sandbox/files/${encodedPath}?projectId=${this._config.projectId}&sandboxId=${this._sandboxId}`,
    );

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }

      const errorData = (await response.json()) as { error?: string };
      throw new Error(errorData.error || 'Failed to read file');
    }

    const data = (await response.json()) as {
      exists: boolean;
      content: string | null;
      encoding: 'utf8' | 'base64';
    };

    if (!data.exists || data.content === null) {
      return null;
    }

    if (data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64');
    }

    return Buffer.from(data.content, 'utf-8');
  }

  /**
   * Create a directory.
   * Uses shell `mkdir` via runCommand because the Vercel SDK's mkDir() is
   * non-recursive and throws on existing directories.  `mkdir -p` handles both.
   * NOTE: prefer writeFiles() for file creation – it auto-creates parent dirs.
   */
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalizedPath = this._normalizePath(path);
    const result = await this.runCommand('mkdir', options?.recursive ? ['-p', normalizedPath] : [normalizedPath]);

    // mkdir without -p exits 1 when dir already exists – treat as success
    if (result.exitCode !== 0 && !options?.recursive) {
      if (result.stderr.includes('File exists')) {
        // Already exists – not an error
      } else {
        throw new Error(`mkdir failed (exit ${result.exitCode}): ${result.stderr}`);
      }
    }

    this._emitFileChange({ type: 'add_dir', path: normalizedPath });
  }

  /**
   * Check if a file or directory exists
   */
  async exists(path: string): Promise<boolean> {
    const normalizedPath = this._normalizePath(path);
    const result = await this.runCommand('test', ['-e', normalizedPath]);

    return result.exitCode === 0;
  }

  /*
   * -------------------------------------------------------------------------
   * Command Execution
   * -------------------------------------------------------------------------
   */

  /**
   * Run a command and wait for completion.
   * Collects stdout/stderr from streaming output and captures the exitCode
   * from the SSE 'exit' event emitted by the server route.
   */
  async runCommand(cmd: string, args: string[] = [], opts?: CommandOptions): Promise<CommandResult> {
    if (!this._sandboxId || !this._config) {
      throw new Error('Sandbox not connected');
    }

    logger.debug('runCommand called', { cmd, args });

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    const response = await fetch('/api/sandbox/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: this._config.projectId,
        sandboxId: this._sandboxId,
        cmd,
        args,
        cwd: opts?.cwd ? this._normalizePath(opts.cwd) : undefined,
        env: opts?.env,
        timeout: opts?.timeout,
        sudo: opts?.sudo,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: string; code?: string; shouldRecreate?: boolean };

      if (response.status === 410 || errorData.code === 'SANDBOX_EXPIRED') {
        throw new Error(`SANDBOX_EXPIRED: ${errorData.error || 'Sandbox expired'}`);
      }

      throw new Error(errorData.error || 'Failed to run command');
    }

    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            continue;
          }

          const data = line.slice(6);

          if (data === '[DONE]') {
            continue;
          }

          try {
            const event: CommandSSEEvent = JSON.parse(data);

            if (event.type === 'output') {
              if (event.stream === 'stdout') {
                stdout += event.data;
              } else {
                stderr += event.data;
              }
            } else if (event.type === 'exit') {
              exitCode = event.exitCode;
            } else if (event.type === 'error') {
              throw new Error(event.message);
            }
          } catch (_e) {
            if (_e instanceof Error && _e.message !== '') {
              throw _e; // re-throw deliberate errors from 'error' events
            }

            // otherwise: malformed SSE chunk, skip
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { exitCode, stdout, stderr };
  }

  /**
   * Run a command with streaming output (SSE)
   */
  async *runCommandStreaming(cmd: string, args: string[] = [], opts?: CommandOptions): AsyncIterable<CommandOutput> {
    if (!this._sandboxId || !this._config) {
      throw new Error('Sandbox not connected');
    }

    const response = await fetch('/api/sandbox/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: this._config.projectId,
        sandboxId: this._sandboxId,
        cmd,
        args,
        cwd: opts?.cwd ? this._normalizePath(opts.cwd) : undefined,
        env: opts?.env,
        timeout: opts?.timeout,
        sudo: opts?.sudo,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: string; code?: string; shouldRecreate?: boolean };

      if (response.status === 410 || errorData.code === 'SANDBOX_EXPIRED') {
        throw new Error(`SANDBOX_EXPIRED: ${errorData.error || 'Sandbox expired'}`);
      }

      throw new Error(errorData.error || 'Failed to run command');
    }

    // Parse SSE stream
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);

            if (data === '[DONE]') {
              continue;
            }

            try {
              const event: CommandSSEEvent = JSON.parse(data);

              if (event.type === 'output') {
                yield { stream: event.stream, data: event.data };
              } else if (event.type === 'error') {
                throw new Error(event.message);
              }

              // 'exit' event handled by caller
            } catch (_e) {
              // Ignore parse errors
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Spawn an interactive shell (limited support via WebSocket proxy)
   */
  async spawnShell(_terminal: TerminalInterface): Promise<ShellProcess> {
    /*
     * For interactive shells, we need a WebSocket connection
     * This is a simplified implementation that runs commands non-interactively
     */
    throw new Error('Interactive shells not yet supported for Vercel Sandbox. Use runCommand instead.');
  }

  /*
   * -------------------------------------------------------------------------
   * Preview
   * -------------------------------------------------------------------------
   */

  /**
   * Get preview URL for a port
   */
  getPreviewUrl(port: number): string | null {
    return this._previewUrls.get(port) ?? null;
  }

  getPreviewUrls(): Map<number, string> {
    return new Map(this._previewUrls);
  }

  /**
   * Subscribe to preview ready events
   */
  onPreviewReady(callback: PreviewCallback): () => void {
    this._previewCallbacks.add(callback);

    // Emit existing preview URLs
    this._previewUrls.forEach((url, port) => {
      callback(port, url);
    });

    return () => this._previewCallbacks.delete(callback);
  }

  /*
   * -------------------------------------------------------------------------
   * Snapshots
   * -------------------------------------------------------------------------
   */

  /**
   * Create a snapshot of current state
   */
  async createSnapshot(): Promise<SnapshotResult> {
    if (!this._sandboxId || !this._config) {
      throw new Error('Sandbox not connected');
    }

    const response = await fetch('/api/sandbox/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: this._config.projectId,
        sandboxId: this._sandboxId,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: string };
      throw new Error(errorData.error || 'Failed to create snapshot');
    }

    const data: CreateSnapshotResponse = await response.json();

    return {
      snapshotId: data.snapshotId,
      provider: 'vercel',
      files: {}, // Files are stored server-side
      createdAt: data.createdAt,
    };
  }

  /**
   * Restore from a snapshot
   */
  async restoreFromSnapshot(snapshotId: string): Promise<void> {
    if (!this._config) {
      throw new Error('Sandbox not configured');
    }

    const response = await fetch(`/api/sandbox/snapshot/${snapshotId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: this._config.projectId,
        snapshotId,
        useVercelSnapshot: true,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: string };
      throw new Error(errorData.error || 'Failed to restore snapshot');
    }

    const data: RestoreSnapshotResponse = await response.json();

    this._sandboxId = data.sandboxId;

    // Update preview URLs
    for (const [port, url] of Object.entries(data.previewUrls)) {
      const portNum = parseInt(port, 10);
      this._previewUrls.set(portNum, url);
      this._previewCallbacks.forEach((cb) => cb(portNum, url));
    }
  }

  /**
   * Extend sandbox timeout
   */
  async extendTimeout(duration: number): Promise<void> {
    if (!this._sandboxId || !this._config) {
      throw new Error('Sandbox not connected');
    }

    const response = await fetch('/api/sandbox/extend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: this._config.projectId,
        sandboxId: this._sandboxId,
        duration,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: string };
      throw new Error(errorData.error || 'Failed to extend timeout');
    }

    const data: ExtendTimeoutResponse = await response.json();
    this._timeoutRemaining = data.newTimeout;

    /*
     * Update creation time to now so timeoutRemaining calculation is accurate after extension
     * The server has extended the timeout, so we treat this as a fresh start for local calculations
     */
    this._createdAt = new Date();
    this._initialTimeout = data.newTimeout;
    this._totalExtensions = 0;

    logger.info('Sandbox timeout extended', {
      duration: duration / 60000,
      totalExtensions: this._totalExtensions / 60000,
      newTimeout: data.newTimeout / 60000,
    });
  }

  /*
   * -------------------------------------------------------------------------
   * Events
   * -------------------------------------------------------------------------
   */

  /**
   * Subscribe to file change events
   */
  onFileChange(callback: FileChangeCallback): () => void {
    this._fileChangeCallbacks.add(callback);
    return () => this._fileChangeCallbacks.delete(callback);
  }

  /*
   * -------------------------------------------------------------------------
   * Private Methods
   * -------------------------------------------------------------------------
   */

  private _setStatus(status: SandboxStatus): void {
    this._status = status;
    this._statusCallbacks.forEach((cb) => cb(status));
  }

  private _emitFileChange(event: FileChangeEvent): void {
    this._fileChangeCallbacks.forEach((cb) => cb(event));
  }

  private _cleanup(): void {
    if (this._timeoutCheckInterval) {
      clearInterval(this._timeoutCheckInterval);
      this._timeoutCheckInterval = null;
    }

    this._sandboxId = null;
    this._timeoutRemaining = null;
    this._previewUrls.clear();

    // Reset timeout tracking fields
    this._createdAt = null;
    this._initialTimeout = null;
    this._totalExtensions = 0;
  }

  private _startTimeoutTracking(): void {
    // Check status periodically to update timeout remaining
    this._timeoutCheckInterval = setInterval(async () => {
      if (!this._sandboxId || !this._config) {
        return;
      }

      try {
        const response = await fetch(
          `/api/sandbox/status?projectId=${this._config.projectId}&sandboxId=${this._sandboxId}`,
        );

        if (!response.ok) {
          // Sandbox may have expired
          this._setStatus('disconnected');
          this._cleanup();

          return;
        }

        const data: GetSandboxStatusResponse = await response.json();
        this._timeoutRemaining = data.timeout;

        // Initialize tracking fields if not set (reconnect case)
        if (!this._createdAt && !this._initialTimeout) {
          // Use expiresAt to back-calculate the creation time if available
          if (data.expiresAt) {
            const expiresAtTime = new Date(data.expiresAt).getTime();
            const now = Date.now();
            const remainingMs = expiresAtTime - now;

            /*
             * Back-calculate creation time: createdAt = now - (initialTimeout - remaining)
             * Assume initialTimeout = data.timeout at creation (may not be accurate after extensions)
             */
            this._createdAt = new Date(now - (data.timeout - remainingMs));
            this._initialTimeout = data.timeout;
            this._totalExtensions = 0;

            logger.info('Initialized timeout tracking from status', {
              createdAt: this._createdAt.toISOString(),
              expiresAt: data.expiresAt,
              initialTimeout: this._initialTimeout / 60000,
            });
          } else {
            // No expiresAt, just use current timestamp as baseline
            this._createdAt = new Date();
            this._initialTimeout = data.timeout;
            this._totalExtensions = 0;

            logger.info('Initialized timeout tracking with current timestamp', {
              initialTimeout: this._initialTimeout / 60000,
            });
          }
        }

        if (data.status === 'stopped' || data.status === 'failed') {
          this._setStatus('disconnected');
          this._cleanup();
        }
      } catch (error) {
        logger.error('Error checking sandbox status:', error);
      }
    }, 30000); // Check every 30 seconds
  }
}
