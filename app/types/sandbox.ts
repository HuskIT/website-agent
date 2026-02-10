/**
 * Shared Sandbox Types
 * Feature: 001-sandbox-providers
 *
 * Types shared across sandbox components, re-exported for convenience.
 */

// Re-export all types from the sandbox module
export type {
  SandboxStatus,
  SandboxProviderType,
  File,
  Folder,
  FileMap,
  FileChangeEvent,
  CommandOptions,
  CommandOutput,
  CommandResult,
  SnapshotResult,
  PreviewInfo,
  SandboxConfig,
  ProviderStatus,
  TerminalInterface,
  ShellProcess,
  SandboxProvider,
  SandboxProviderFactory,
} from '~/lib/sandbox/types';

// Re-export schemas for validation
export {
  SandboxStatusSchema,
  SandboxProviderTypeSchema,
  FileSchema,
  FolderSchema,
  FileMapSchema,
  FileChangeEventSchema,
  CommandOptionsSchema,
  CommandOutputSchema,
  CommandResultSchema,
  SnapshotResultSchema,
  PreviewInfoSchema,
  SandboxConfigSchema,
  ProviderStatusSchema,
} from '~/lib/sandbox/types';

/**
 * Extended preview info with provider context.
 * Used in the PreviewsStore to track which provider owns each preview.
 */
export interface ExtendedPreviewInfo {
  port: number;
  url: string;
  ready: boolean;
  provider: 'webcontainer' | 'vercel';
}

/**
 * File sync state for tracking provider synchronization.
 */
export interface FileSyncState {
  /** Files pending write to provider */
  pendingWrites: string[];

  /** Files being synced (in flight) */
  syncing: string[];

  /** Last sync timestamp per file */
  syncedAt: Record<string, number>;

  /** Sync errors */
  errors: Record<string, string>;
}

/**
 * Sandbox settings for user preferences.
 */
export interface SandboxSettings {
  /** User's preferred provider */
  preferredProvider: 'webcontainer' | 'vercel';

  /** Auto-save settings */
  autoSnapshotOnDisconnect: boolean;
  autoSnapshotInterval: number; // 0 = disabled

  /** Timeout settings */
  timeoutWarningThreshold: number; // ms before timeout to warn
  autoExtendOnActivity: boolean;

  /** Advanced/debug */
  forceLocalProvider: boolean;
}

/**
 * Default sandbox settings.
 */
export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  preferredProvider: 'vercel',
  autoSnapshotOnDisconnect: true,
  autoSnapshotInterval: 0,
  timeoutWarningThreshold: 120000, // 2 minutes
  autoExtendOnActivity: true,
  forceLocalProvider: false,
};
