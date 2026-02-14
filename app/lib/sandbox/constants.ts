/**
 * Sandbox Constants
 * Feature: 001-sandbox-providers
 *
 * Centralized configuration for Vercel Sandbox timeouts and limits.
 * All timeout values are in milliseconds.
 */

/**
 * Default sandbox session timeout
 * Currently set to 10 minutes (600,000ms)
 */
export const DEFAULT_SANDBOX_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Minimum allowed sandbox timeout
 * 1 minute (60,000ms)
 */
export const MIN_SANDBOX_TIMEOUT_MS = 1 * 60 * 1000;

/**
 * Maximum allowed sandbox timeout
 * 5 hours (18,000,000ms)
 */
export const MAX_SANDBOX_TIMEOUT_MS = 5 * 60 * 60 * 1000;

/**
 * Default extension duration when user sends a prompt
 * 3 minutes (180,000ms)
 */
export const PROMPT_EXTENSION_MS = 3 * 60 * 1000;

/**
 * Default extension duration for danger zone activity
 * 2 minutes (120,000ms)
 */
export const ACTIVITY_EXTENSION_MS = 2 * 60 * 1000;

/**
 * Danger zone window before timeout
 * Final 2 minutes where activity triggers extension
 */
export const DANGER_ZONE_WINDOW_MS = 2 * 60 * 1000;

/**
 * Warning threshold before timeout
 * Show warning when 2 minutes remain
 */
export const WARNING_THRESHOLD_MS = 2 * 60 * 1000;

/**
 * Timeout check interval
 * Check status every 30 seconds
 */
export const CHECK_INTERVAL_MS = 30 * 1000;

/**
 * Minimum time between auto-extensions
 * Rate limit: 1 minute between extensions
 */
export const MIN_AUTO_EXTEND_INTERVAL_MS = 60 * 1000;

/**
 * Default sandbox ports
 */
export const DEFAULT_SANDBOX_PORTS = [3000, 5173];

/**
 * Default sandbox runtime
 */
export const DEFAULT_SANDBOX_RUNTIME = 'node22';

/**
 * Sandbox filesystem root
 * Vercel Sandbox uses root directory (/) as the project root
 */
export const SANDBOX_ROOT = '/';

/**
 * Minimum required time for operations (upload + install + dev start)
 * 3 minutes (180,000ms)
 */
export const MIN_REQUIRED_TIME_MS = 3 * 60 * 1000;
