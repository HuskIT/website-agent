/**
 * Sandbox Provider Diagnostics
 *
 * Run in browser console to debug provider routing issues:
 * ```
 * import('/app/utils/sandbox-diagnostics.js').then(m => m.runDiagnostics())
 * ```
 */

import { sandboxState, getProviderInstance } from '~/lib/stores/sandbox';

export function runDiagnostics() {
  console.group('🔍 Sandbox Provider Diagnostics');

  const state = sandboxState.get();
  const provider = getProviderInstance();

  console.log('📊 Store State:', {
    providerType: state.providerType,
    status: state.status,
    sandboxId: state.sandboxId,
    projectId: state.projectId,
    error: state.error,
    previewUrls: state.previewUrls,
    vercelEnabled: state.vercelEnabled,
    defaultProvider: state.defaultProvider,
  });

  console.log('📦 Provider Instance:', {
    exists: !!provider,
    type: provider?.type ?? 'null',
    status: provider?.status ?? 'null',
    sandboxId: provider?.sandboxId ?? 'null',
    hasConnect: typeof provider?.connect === 'function',
    hasRunCommand: typeof provider?.runCommand === 'function',
    hasWriteFiles: typeof provider?.writeFiles === 'function',
  });

  // Check if provider is ready for commands
  const isReady = provider && provider.status === 'connected';
  console.log(`${isReady ? '✅' : '❌'} Provider Ready for Commands:`, isReady ? 'YES' : 'NO');

  if (!isReady) {
    console.warn('⚠️ Commands will fall back to WebContainer');

    if (!provider) {
      console.error('❌ Provider instance not set. Check if workbenchStore.initializeProvider() was called.');
    } else if (provider.status !== 'connected') {
      console.error(`❌ Provider status is "${provider.status}", expected "connected".`);
      console.log('Check browser console for connection errors.');
    }
  }

  console.groupEnd();

  return {
    state,
    provider: provider
      ? {
          type: provider.type,
          status: provider.status,
          sandboxId: provider.sandboxId,
        }
      : null,
    isReady,
  };
}

/**
 * Watch provider changes in real-time
 */
export function watchProvider(duration: number = 60000) {
  console.log(`👀 Watching provider for ${duration / 1000}s...`);

  const unsubscribe = sandboxState.listen((state) => {
    const provider = getProviderInstance();
    console.log('[Provider Change]', {
      timestamp: new Date().toISOString(),
      status: state.status,
      providerType: state.providerType,
      sandboxId: state.sandboxId,
      hasProviderInstance: !!provider,
      providerStatus: provider?.status ?? 'null',
    });
  });

  setTimeout(() => {
    unsubscribe();
    console.log('✅ Stopped watching provider');
  }, duration);
}
