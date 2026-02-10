/**
 * Sandbox Store
 * Feature: 001-sandbox-providers
 *
 * Manages sandbox provider state using Nanostores.
 * Coordinates provider lifecycle, status updates, and timeout tracking.
 */

import { atom, computed } from 'nanostores';
import type { SandboxProvider, SandboxStatus, SandboxProviderType, PreviewInfo } from '~/lib/sandbox/types';

/*
 * =============================================================================
 * State Types
 * =============================================================================
 */

export interface SandboxState {
  /** Current provider type */
  providerType: SandboxProviderType;

  /** Connection status */
  status: SandboxStatus;

  /** Active sandbox ID (for Vercel) */
  sandboxId: string | null;

  /** Associated project */
  projectId: string | null;

  /** Timeout tracking (Vercel only) */
  timeoutRemaining: number | null;
  timeoutWarningShown: boolean;

  /** Activity tracking for timeout extension */
  lastActivity: number;

  /** Error state */
  error: string | null;

  /** Preview URLs */
  previewUrls: PreviewInfo[];

  /** Feature flags */
  vercelEnabled: boolean;
  defaultProvider: SandboxProviderType;
}

/*
 * =============================================================================
 * Initial State
 * =============================================================================
 */

const DEFAULT_STATE: SandboxState = {
  providerType: 'vercel',
  status: 'disconnected',
  sandboxId: null,
  projectId: null,
  timeoutRemaining: null,
  timeoutWarningShown: false,
  lastActivity: Date.now(),
  error: null,
  previewUrls: [],
  vercelEnabled: true,
  defaultProvider: 'vercel',
};

/*
 * =============================================================================
 * Atoms
 * =============================================================================
 */

/** Main sandbox state atom */
export const sandboxState = atom<SandboxState>(DEFAULT_STATE);

/** Provider instance (not serializable, kept separate) */
let providerInstance: SandboxProvider | null = null;

/*
 * =============================================================================
 * Computed Values
 * =============================================================================
 */

/** Whether sandbox is connected and ready */
export const isConnected = computed(sandboxState, (state) => state.status === 'connected');

/** Whether sandbox is in a loading state */
export const isLoading = computed(
  sandboxState,
  (state) => state.status === 'connecting' || state.status === 'reconnecting',
);

/** Whether sandbox has an error */
export const hasError = computed(sandboxState, (state) => state.status === 'error');

/** Whether timeout warning should be shown */
export const shouldShowTimeoutWarning = computed(sandboxState, (state) => {
  if (state.providerType !== 'vercel') {
    return false;
  }

  if (state.timeoutRemaining === null) {
    return false;
  }

  // Show warning when less than 2 minutes remaining
  return state.timeoutRemaining < 120000 && !state.timeoutWarningShown;
});

/** Get preview URL for a specific port */
export const getPreviewUrl = (port: number) =>
  computed(sandboxState, (state) => {
    const preview = state.previewUrls.find((p) => p.port === port);
    return preview?.ready ? preview.url : null;
  });

/*
 * =============================================================================
 * Actions
 * =============================================================================
 */

/**
 * Set the provider type (webcontainer or vercel)
 */
export function setProviderType(type: SandboxProviderType): void {
  sandboxState.set({
    ...sandboxState.get(),
    providerType: type,
  });
}

/**
 * Set connection status
 */
export function setStatus(status: SandboxStatus): void {
  const prevStatus = sandboxState.get().status;
  console.log('[SandboxStore] setStatus:', { from: prevStatus, to: status });
  sandboxState.set({
    ...sandboxState.get(),
    status,

    // Clear error when status changes from error
    error: status === 'error' ? sandboxState.get().error : null,
  });
}

/**
 * Set sandbox ID (for Vercel)
 */
export function setSandboxId(id: string | null): void {
  sandboxState.set({
    ...sandboxState.get(),
    sandboxId: id,
  });
}

/**
 * Set project ID
 */
export function setProjectId(id: string | null): void {
  sandboxState.set({
    ...sandboxState.get(),
    projectId: id,
  });
}

/**
 * Set error message
 */
export function setError(error: string | null): void {
  sandboxState.set({
    ...sandboxState.get(),
    error,
    status: error ? 'error' : sandboxState.get().status,
  });
}

/**
 * Update timeout remaining (Vercel only)
 */
export function setTimeoutRemaining(ms: number | null): void {
  sandboxState.set({
    ...sandboxState.get(),
    timeoutRemaining: ms,
  });
}

/**
 * Show timeout warning
 */
export function showTimeoutWarning(): void {
  sandboxState.set({
    ...sandboxState.get(),
    timeoutWarningShown: true,
  });
}

/**
 * Hide timeout warning
 */
export function hideTimeoutWarning(): void {
  sandboxState.set({
    ...sandboxState.get(),
    timeoutWarningShown: false,
  });
}

/**
 * Record user activity (for timeout extension)
 */
export function recordActivity(): void {
  sandboxState.set({
    ...sandboxState.get(),
    lastActivity: Date.now(),
  });
}

/**
 * Get last activity timestamp
 */
export function getLastActivity(): number {
  return sandboxState.get().lastActivity;
}

/**
 * Add or update a preview URL
 */
export function setPreviewUrl(port: number, url: string, ready: boolean = true): void {
  const state = sandboxState.get();
  const existing = state.previewUrls.findIndex((p) => p.port === port);

  const newPreview: PreviewInfo = { port, url, ready };
  const newUrls =
    existing >= 0
      ? [...state.previewUrls.slice(0, existing), newPreview, ...state.previewUrls.slice(existing + 1)]
      : [...state.previewUrls, newPreview];

  sandboxState.set({
    ...state,
    previewUrls: newUrls,
  });
}

/**
 * Clear all preview URLs
 */
export function clearPreviewUrls(): void {
  sandboxState.set({
    ...sandboxState.get(),
    previewUrls: [],
  });
}

/**
 * Set feature flags
 */
export function setVercelEnabled(enabled: boolean): void {
  sandboxState.set({
    ...sandboxState.get(),
    vercelEnabled: enabled,
  });
}

export function setDefaultProvider(provider: SandboxProviderType): void {
  sandboxState.set({
    ...sandboxState.get(),
    defaultProvider: provider,
  });
}

/*
 * =============================================================================
 * Provider Instance Management
 * =============================================================================
 */

/**
 * Set the provider instance (called by factory)
 */
export function setProviderInstance(provider: SandboxProvider | null): void {
  console.log('[SandboxStore] setProviderInstance:', {
    from: providerInstance?.type ?? 'null',
    to: provider?.type ?? 'null',
    sandboxId: provider?.sandboxId ?? 'null',
    status: provider?.status ?? 'null',
  });
  providerInstance = provider;
}

/**
 * Get the provider instance
 */
export function getProviderInstance(): SandboxProvider | null {
  // Debug logging
  if (providerInstance) {
    console.log('[SandboxStore] getProviderInstance:', {
      type: providerInstance.type,
      status: providerInstance.status,
      sandboxId: providerInstance.sandboxId,
      timestamp: Date.now(),
    });
  } else {
    console.log('[SandboxStore] getProviderInstance: null', {
      timestamp: Date.now(),
      stack: new Error().stack?.split('\n').slice(2, 5).join(' | '),
    });
  }

  return providerInstance;
}

/**
 * Force set provider status (for debugging/reconnection scenarios)
 */
export function forceSetProviderStatus(status: SandboxStatus): void {
  console.log('[SandboxStore] forceSetProviderStatus:', {
    from: providerInstance?.status ?? 'null',
    to: status,
    sandboxId: providerInstance?.sandboxId ?? 'null',
  });

  if (providerInstance) {
    // @ts-ignore - accessing private _status for recovery
    providerInstance._status = status;
    setStatus(status);
  }
}

/**
 * Get provider instance, throwing if not available
 */
export function requireProvider(): SandboxProvider {
  if (!providerInstance) {
    throw new Error('Sandbox provider not initialized. Call connect() first.');
  }

  return providerInstance;
}

/*
 * =============================================================================
 * Connection Lifecycle
 * =============================================================================
 */

/**
 * Connect to sandbox (called after provider is created)
 */
export function onConnect(sandboxId: string | null, projectId: string): void {
  sandboxState.set({
    ...sandboxState.get(),
    status: 'connected',
    sandboxId,
    projectId,
    error: null,
    lastActivity: Date.now(),
  });
}

/**
 * Handle disconnection
 */
export function onDisconnect(): void {
  console.log('[SandboxStore] onDisconnect called', {
    currentProvider: providerInstance?.type ?? 'null',
    sandboxId: providerInstance?.sandboxId ?? 'null',
  });
  sandboxState.set({
    ...sandboxState.get(),
    status: 'disconnected',
    sandboxId: null,
    timeoutRemaining: null,
    timeoutWarningShown: false,
    previewUrls: [],
  });
  providerInstance = null;
}

/**
 * Handle connection error
 */
export function onError(error: string): void {
  sandboxState.set({
    ...sandboxState.get(),
    status: 'error',
    error,
  });
}

/**
 * Reset to initial state
 */
export function reset(): void {
  sandboxState.set(DEFAULT_STATE);
  providerInstance = null;
}

/*
 * =============================================================================
 * HMR Preservation
 * =============================================================================
 */

if (import.meta.hot) {
  import.meta.hot.data.sandboxState ??= sandboxState.get();
  sandboxState.set(import.meta.hot.data.sandboxState);

  import.meta.hot.dispose(() => {
    import.meta.hot!.data.sandboxState = sandboxState.get();
  });
}
