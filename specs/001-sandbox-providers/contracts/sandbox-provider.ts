/**
 * Sandbox Provider Interface Contract
 * Feature: 001-sandbox-providers
 *
 * This file defines the interface that both WebContainerProvider and
 * VercelSandboxProvider must implement.
 *
 * Implementation Status: ✅ Fully implemented
 * Actual Implementation: app/lib/sandbox/types.ts (canonical source)
 * Providers:
 * - app/lib/sandbox/providers/webcontainer.ts (WebContainerProvider)
 * - app/lib/sandbox/providers/vercel-sandbox.ts (VercelSandboxProvider)
 */

import { z } from 'zod';

// =============================================================================
// Status Types
// =============================================================================

export const SandboxStatusSchema = z.enum([
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'error',
]);
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

export const SandboxProviderTypeSchema = z.enum(['webcontainer', 'vercel']);
export type SandboxProviderType = z.infer<typeof SandboxProviderTypeSchema>;

// =============================================================================
// File Types
// =============================================================================

export const FileSchema = z.object({
  type: z.literal('file'),
  content: z.string(),
  isBinary: z.boolean(),
  isLocked: z.boolean().optional(),
});
export type File = z.infer<typeof FileSchema>;

export const FolderSchema = z.object({
  type: z.literal('folder'),
  isLocked: z.boolean().optional(),
});
export type Folder = z.infer<typeof FolderSchema>;

export const FileMapSchema = z.record(z.string(), z.union([FileSchema, FolderSchema]).optional());
export type FileMap = z.infer<typeof FileMapSchema>;

export const FileChangeEventSchema = z.object({
  type: z.enum(['add', 'change', 'remove', 'add_dir', 'remove_dir']),
  path: z.string(),
  content: z.string().optional(),
});
export type FileChangeEvent = z.infer<typeof FileChangeEventSchema>;

// =============================================================================
// Command Types
// =============================================================================

export const CommandOptionsSchema = z.object({
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().optional(),
  sudo: z.boolean().optional(), // Vercel only
  detached: z.boolean().optional(),
});
export type CommandOptions = z.infer<typeof CommandOptionsSchema>;

export const CommandOutputSchema = z.object({
  stream: z.enum(['stdout', 'stderr']),
  data: z.string(),
});
export type CommandOutput = z.infer<typeof CommandOutputSchema>;

export const CommandResultSchema = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

// =============================================================================
// Snapshot Types
// =============================================================================

export const SnapshotResultSchema = z.object({
  snapshotId: z.string(),
  provider: z.enum(['local', 'vercel']),
  files: FileMapSchema,
  createdAt: z.string().datetime(),
});
export type SnapshotResult = z.infer<typeof SnapshotResultSchema>;

// =============================================================================
// Preview Types
// =============================================================================

export const PreviewInfoSchema = z.object({
  port: z.number(),
  url: z.string().url(),
  ready: z.boolean(),
});
export type PreviewInfo = z.infer<typeof PreviewInfoSchema>;

// =============================================================================
// Provider Configuration
// =============================================================================

export const SandboxConfigSchema = z.object({
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
  snapshotId: z.string().optional(),
  workdir: z.string().default('/home/project'),
  timeout: z.number().default(5 * 60 * 1000), // 5 minutes default
  ports: z.array(z.number()).default([3000, 5173, 8080]),
  runtime: z.enum(['node22', 'node24', 'python3.13']).default('node22'),
});
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

// =============================================================================
// Provider Status
// =============================================================================

export const ProviderStatusSchema = z.object({
  type: SandboxProviderTypeSchema,
  status: SandboxStatusSchema,
  sandboxId: z.string().nullable(),
  timeoutRemaining: z.number().nullable(), // null for WebContainer
  previewUrls: z.array(PreviewInfoSchema),
  error: z.string().nullable(),
  lastActivity: z.number(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

// =============================================================================
// Terminal Interface (for shell spawning)
// =============================================================================

export interface TerminalInterface {
  cols: number;
  rows: number;
  write(data: string): void;
  onData(callback: (data: string) => void): () => void;
  onResize(callback: (cols: number, rows: number) => void): () => void;
}

export interface ShellProcess {
  kill(): Promise<void>;
  resize(cols: number, rows: number): void;
  write(data: string): void;
}

// =============================================================================
// SandboxProvider Interface
// =============================================================================

/**
 * Core interface that both WebContainerProvider and VercelSandboxProvider implement.
 * All operations are async to support both local and remote execution.
 */
export interface SandboxProvider {
  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /** Provider type identifier */
  readonly type: SandboxProviderType;

  /** Active sandbox session ID (null if disconnected) */
  readonly sandboxId: string | null;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize and connect to a sandbox.
   * For WebContainer: boots the container
   * For Vercel: creates a new sandbox or restores from snapshot
   */
  connect(config: SandboxConfig): Promise<void>;

  /**
   * Disconnect from the sandbox.
   * Triggers auto-snapshot before disconnect.
   */
  disconnect(): Promise<void>;

  /**
   * Attempt to reconnect to an existing sandbox session.
   * Returns false if session expired or not found.
   * Only applicable to Vercel (WebContainer always returns false).
   */
  reconnect(sandboxId: string): Promise<boolean>;

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** Current connection status */
  readonly status: SandboxStatus;

  /** Time remaining until timeout in ms (null for WebContainer) */
  readonly timeoutRemaining: number | null;

  /** Subscribe to status changes */
  onStatusChange(callback: (status: SandboxStatus) => void): () => void;

  // -------------------------------------------------------------------------
  // File Operations
  // -------------------------------------------------------------------------

  /**
   * Write a single file.
   * Creates parent directories automatically.
   */
  writeFile(path: string, content: string | Buffer): Promise<void>;

  /**
   * Write multiple files in a batch.
   * More efficient for Vercel (single API call).
   */
  writeFiles(files: Array<{ path: string; content: Buffer }>): Promise<void>;

  /**
   * Read file contents as string.
   * Returns null if file doesn't exist.
   */
  readFile(path: string): Promise<string | null>;

  /**
   * Read file contents as buffer.
   * Returns null if file doesn't exist.
   */
  readFileBuffer(path: string): Promise<Buffer | null>;

  /**
   * Create a directory.
   */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;

  /**
   * Check if a file or directory exists.
   */
  exists(path: string): Promise<boolean>;

  // -------------------------------------------------------------------------
  // Command Execution
  // -------------------------------------------------------------------------

  /**
   * Run a command and wait for completion.
   * Returns full result with exit code, stdout, stderr.
   */
  runCommand(cmd: string, args?: string[], opts?: CommandOptions): Promise<CommandResult>;

  /**
   * Run a command with streaming output.
   * Yields output chunks as they arrive.
   */
  runCommandStreaming(
    cmd: string,
    args?: string[],
    opts?: CommandOptions
  ): AsyncIterable<CommandOutput>;

  /**
   * Spawn an interactive shell connected to a terminal.
   * Used for the integrated terminal UI.
   */
  spawnShell(terminal: TerminalInterface): Promise<ShellProcess>;

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  /**
   * Get the preview URL for a given port.
   * Returns null if port not exposed or server not ready.
   */
  getPreviewUrl(port: number): string | null;

  /**
   * Subscribe to preview ready events.
   * Called when a server starts listening on a port.
   */
  onPreviewReady(callback: (port: number, url: string) => void): () => void;

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  /**
   * Create a snapshot of the current state.
   * For Vercel: also creates a cloud snapshot for fast restore.
   * Always includes FileMap for backup.
   */
  createSnapshot(): Promise<SnapshotResult>;

  /**
   * Restore sandbox state from a snapshot.
   * Uses Vercel snapshot if available, otherwise FileMap.
   */
  restoreFromSnapshot(snapshotId: string): Promise<void>;

  /**
   * Extend the sandbox timeout.
   * No-op for WebContainer.
   */
  extendTimeout(duration: number): Promise<void>;

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * Subscribe to file change events.
   * Used to sync provider FS → Nanostores.
   */
  onFileChange(callback: (event: FileChangeEvent) => void): () => void;
}

// =============================================================================
// Factory Function Type
// =============================================================================

export type SandboxProviderFactory = (
  type: SandboxProviderType,
  config: SandboxConfig
) => SandboxProvider;
