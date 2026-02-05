/**
 * Store Contracts for Sandbox State Management
 * Feature: 001-sandbox-providers
 *
 * Defines the Nanostore atoms and maps for managing sandbox state.
 * These stores integrate with the existing workbench, files, and preview stores.
 *
 * Implementation Status: ✅ All stores implemented
 * Actual Implementations:
 * - app/lib/stores/sandbox.ts (SandboxState atom, actions)
 * - app/lib/stores/workbench.ts (initializeProvider, switchProvider)
 * - app/lib/stores/files.ts (provider-aware sync)
 * - app/lib/stores/previews.ts (multi-provider URLs)
 * - app/types/sandbox.ts (extended types)
 */

import { z } from 'zod';
import type { SandboxProvider, SandboxStatus, SandboxProviderType, PreviewInfo } from './sandbox-provider';

// =============================================================================
// Sandbox Store State
// =============================================================================

export const SandboxStateSchema = z.object({
  // Current provider instance (runtime only, not serializable)
  // provider: SandboxProvider | null (not in schema - runtime reference)

  // Provider type selection
  providerType: z.enum(['webcontainer', 'vercel']),

  // Connection state
  status: z.enum(['disconnected', 'connecting', 'connected', 'reconnecting', 'error']),

  // Active sandbox ID (for Vercel)
  sandboxId: z.string().nullable(),

  // Associated project
  projectId: z.string().uuid().nullable(),

  // Timeout tracking (Vercel only)
  timeoutRemaining: z.number().nullable(),
  timeoutWarningShown: z.boolean(),

  // Activity tracking for timeout extension
  lastActivity: z.number(),

  // Error state
  error: z.string().nullable(),

  // Feature flags / configuration
  vercelEnabled: z.boolean(),
  defaultProvider: z.enum(['webcontainer', 'vercel']),
});
export type SandboxState = z.infer<typeof SandboxStateSchema>;

// =============================================================================
// Sandbox Store Interface
// =============================================================================

/**
 * Interface for the sandbox store.
 * Uses Nanostores atom pattern.
 */
export interface SandboxStore {
  // State access
  get(): SandboxState;
  subscribe(callback: (state: SandboxState) => void): () => void;

  // Provider lifecycle
  setProviderType(type: SandboxProviderType): void;
  connect(projectId: string, snapshotId?: string): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(sandboxId: string): Promise<boolean>;

  // Provider instance access (lazy initialized)
  getProvider(): Promise<SandboxProvider>;

  // Status updates (called by provider internally)
  setStatus(status: SandboxStatus): void;
  setError(error: string | null): void;
  setSandboxId(id: string | null): void;

  // Activity tracking
  recordActivity(): void;
  getLastActivity(): number;

  // Timeout management
  setTimeoutRemaining(ms: number | null): void;
  showTimeoutWarning(): void;
  hideTimeoutWarning(): void;

  // Configuration
  setVercelEnabled(enabled: boolean): void;
  setDefaultProvider(provider: SandboxProviderType): void;
}

// =============================================================================
// Preview Store Extensions
// =============================================================================

/**
 * Extended preview info for provider-aware preview handling.
 */
export const ExtendedPreviewInfoSchema = z.object({
  port: z.number(),
  url: z.string().url(),
  ready: z.boolean(),
  provider: z.enum(['webcontainer', 'vercel']),
});
export type ExtendedPreviewInfo = z.infer<typeof ExtendedPreviewInfoSchema>;

/**
 * Preview store should be extended to:
 * 1. Track which provider owns each preview
 * 2. Clear previews when provider changes
 * 3. Handle different URL formats per provider
 */
export interface ExtendedPreviewsStore {
  // Existing methods...
  previews: ExtendedPreviewInfo[];

  // New methods
  setProviderForPreviews(provider: SandboxProviderType): void;
  clearProviderPreviews(provider: SandboxProviderType): void;
  addPreview(port: number, url: string, provider: SandboxProviderType): void;
}

// =============================================================================
// Files Store Extensions
// =============================================================================

/**
 * File sync state for tracking provider synchronization.
 */
export const FileSyncStateSchema = z.object({
  // Files pending write to provider
  pendingWrites: z.array(z.string()),

  // Files being synced (in flight)
  syncing: z.array(z.string()),

  // Last sync timestamp per file
  syncedAt: z.record(z.string(), z.number()),

  // Sync errors
  errors: z.record(z.string(), z.string()),
});
export type FileSyncState = z.infer<typeof FileSyncStateSchema>;

/**
 * Files store should be extended to:
 * 1. Track sync state with provider
 * 2. Queue writes for batch processing
 * 3. Handle sync failures gracefully
 */
export interface ExtendedFilesStore {
  // Existing methods...

  // Sync state
  getSyncState(): FileSyncState;
  onSyncStateChange(callback: (state: FileSyncState) => void): () => void;

  // Batch operations
  queueWrite(path: string, content: string): void;
  flushWrites(): Promise<void>;

  // Error handling
  retrySyncErrors(): Promise<void>;
  clearSyncError(path: string): void;
}

// =============================================================================
// Workbench Store Extensions
// =============================================================================

/**
 * Workbench store should be extended to:
 * 1. Coordinate provider initialization
 * 2. Handle provider switching
 * 3. Manage action execution through provider abstraction
 */
export interface ExtendedWorkbenchStore {
  // Existing methods...

  // Provider management
  initializeProvider(projectId: string): Promise<void>;
  switchProvider(newProvider: SandboxProviderType): Promise<void>;
  getCurrentProvider(): SandboxProviderType;

  // Provider-aware action execution
  executeFileAction(path: string, content: string): Promise<void>;
  executeShellAction(command: string): Promise<void>;

  // Session management
  saveAndDisconnect(): Promise<void>;
  reconnectOrRestore(projectId: string): Promise<void>;
}

// =============================================================================
// Settings Store Extensions
// =============================================================================

/**
 * Settings for sandbox configuration in the @settings panel.
 */
export const SandboxSettingsSchema = z.object({
  // User preference
  preferredProvider: z.enum(['webcontainer', 'vercel']),

  // Auto-save settings
  autoSnapshotOnDisconnect: z.boolean().default(true),
  autoSnapshotInterval: z.number().min(0).max(3600000).default(0), // 0 = disabled

  // Timeout settings
  timeoutWarningThreshold: z.number().min(30000).max(300000).default(120000), // 2 min default
  autoExtendOnActivity: z.boolean().default(true),

  // Advanced
  forceLocalProvider: z.boolean().default(false), // Debug/fallback
});
export type SandboxSettings = z.infer<typeof SandboxSettingsSchema>;

// =============================================================================
// Store Actions
// =============================================================================

/**
 * Actions that can be dispatched to modify store state.
 * Useful for debugging and time-travel debugging.
 */
export const SandboxActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SET_PROVIDER_TYPE'),
    payload: z.enum(['webcontainer', 'vercel']),
  }),
  z.object({
    type: z.literal('SET_STATUS'),
    payload: z.enum(['disconnected', 'connecting', 'connected', 'reconnecting', 'error']),
  }),
  z.object({
    type: z.literal('SET_SANDBOX_ID'),
    payload: z.string().nullable(),
  }),
  z.object({
    type: z.literal('SET_ERROR'),
    payload: z.string().nullable(),
  }),
  z.object({
    type: z.literal('SET_TIMEOUT'),
    payload: z.number().nullable(),
  }),
  z.object({
    type: z.literal('RECORD_ACTIVITY'),
    payload: z.number(), // timestamp
  }),
  z.object({
    type: z.literal('CONNECT_SUCCESS'),
    payload: z.object({
      sandboxId: z.string(),
      projectId: z.string(),
    }),
  }),
  z.object({
    type: z.literal('DISCONNECT'),
  }),
]);
export type SandboxAction = z.infer<typeof SandboxActionSchema>;

// =============================================================================
// Initial State Factory
// =============================================================================

export function createInitialSandboxState(
  overrides?: Partial<SandboxState>
): SandboxState {
  return {
    providerType: 'vercel',
    status: 'disconnected',
    sandboxId: null,
    projectId: null,
    timeoutRemaining: null,
    timeoutWarningShown: false,
    lastActivity: Date.now(),
    error: null,
    vercelEnabled: true,
    defaultProvider: 'vercel',
    ...overrides,
  };
}
