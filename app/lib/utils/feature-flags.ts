/**
 * Feature Flags Configuration
 *
 * Centralized feature flag management for toggling features on/off.
 * All flags default to enabled (true) unless explicitly disabled.
 */

/**
 * Check if console interceptor is enabled
 * Default: true (enabled)
 * Set CONSOLE_INTERCEPTOR_ENABLED=false to disable
 */
export function isConsoleInterceptorEnabled(): boolean {
  // Check both import.meta.env (client) and process.env (server)
  const value = import.meta.env?.CONSOLE_INTERCEPTOR_ENABLED ?? process.env?.CONSOLE_INTERCEPTOR_ENABLED ?? 'true';

  return value !== 'false' && value !== false;
}
