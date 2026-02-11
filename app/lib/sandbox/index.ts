/**
 * Sandbox Module Entry Point
 * Feature: 001-sandbox-providers
 *
 * Exports the provider factory and types for creating sandbox instances.
 */

import type { SandboxProvider, SandboxProviderType, SandboxConfig } from './types';
import { setProviderInstance, setStatus, setProviderType } from '~/lib/stores/sandbox';

// Re-export types
export * from './types';
export * from './schemas';

// Lazy-load providers to avoid bundling both on initial load
let webContainerProviderClass: typeof import('./providers/webcontainer').WebContainerProvider | null = null;
let vercelSandboxProviderClass: typeof import('./providers/vercel-sandbox').VercelSandboxProvider | null = null;

/**
 * Create a sandbox provider instance.
 *
 * @param type - The type of provider to create ('webcontainer' or 'vercel')
 * @param config - Configuration for the sandbox
 * @returns A configured SandboxProvider instance
 */
export interface CreateSandboxProviderOptions {
  skipConnect?: boolean; // For reconnection scenarios - connect manually after
}

export async function createSandboxProvider(
  type: SandboxProviderType,
  config: SandboxConfig,
  options?: CreateSandboxProviderOptions,
): Promise<SandboxProvider> {
  console.log('[createSandboxProvider] Starting', {
    type,
    projectId: config.projectId,
    skipConnect: options?.skipConnect,
  });

  // Update store with provider type
  setProviderType(type);

  if (!options?.skipConnect) {
    setStatus('connecting');
  }

  let provider: SandboxProvider;

  try {
    if (type === 'webcontainer') {
      // Lazy-load WebContainerProvider
      if (!webContainerProviderClass) {
        const module = await import('./providers/webcontainer');
        webContainerProviderClass = module.WebContainerProvider;
      }

      provider = new webContainerProviderClass();
    } else if (type === 'vercel') {
      // Lazy-load VercelSandboxProvider
      if (!vercelSandboxProviderClass) {
        const module = await import('./providers/vercel-sandbox');
        vercelSandboxProviderClass = module.VercelSandboxProvider;
      }

      provider = new vercelSandboxProviderClass();
    } else {
      throw new Error(`Unknown provider type: ${type}`);
    }

    // Store the provider instance
    console.log('[createSandboxProvider] Provider created, storing instance', {
      type,
      sandboxId: provider.sandboxId,
      status: provider.status,
    });
    setProviderInstance(provider);

    // Connect with config (unless skipped for reconnection)
    if (!options?.skipConnect) {
      console.log('[createSandboxProvider] Connecting provider...', { type, projectId: config.projectId });
      await provider.connect(config);
      console.log('[createSandboxProvider] Provider connected successfully', {
        type,
        sandboxId: provider.sandboxId,
        status: provider.status,
      });
    } else {
      console.log('[createSandboxProvider] Skipping connect (reconnection mode)', {
        type,
        projectId: config.projectId,
      });
    }

    return provider;
  } catch (error) {
    setStatus('error');
    throw error;
  }
}

/**
 * Get the default provider type based on environment configuration.
 * For MVP: Set SANDBOX_PROVIDER_DEFAULT=vercel in .env.local for cloud sandbox.
 */
export function getDefaultProviderType(): SandboxProviderType {
  // Check environment variable
  const envDefault = typeof process !== 'undefined' ? process.env.SANDBOX_PROVIDER_DEFAULT : undefined;

  if (envDefault === 'webcontainer' || envDefault === 'vercel') {
    return envDefault;
  }

  // Default to webcontainer if Vercel is not enabled
  return isVercelEnabled() ? 'vercel' : 'webcontainer';
}

/**
 * Check if Vercel Sandbox is enabled.
 */
export function isVercelEnabled(): boolean {
  const envEnabled = typeof process !== 'undefined' ? process.env.SANDBOX_VERCEL_ENABLED : undefined;
  return envEnabled !== 'false';
}

/**
 * Determine which provider to use for a project.
 *
 * @param userPreference - User's preferred provider (from settings)
 * @param projectProvider - Provider previously used for this project
 * @returns The provider type to use
 */
export function resolveProviderType(
  userPreference?: SandboxProviderType,
  projectProvider?: SandboxProviderType,
): SandboxProviderType {
  // If Vercel is disabled, force WebContainer
  if (!isVercelEnabled()) {
    return 'webcontainer';
  }

  // Prefer project's existing provider for consistency
  if (projectProvider) {
    return projectProvider;
  }

  // Then user preference
  if (userPreference) {
    return userPreference;
  }

  // Finally, system default
  return getDefaultProviderType();
}
