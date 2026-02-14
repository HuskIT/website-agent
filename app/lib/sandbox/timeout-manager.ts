/**
 * Timeout Manager
 * Feature: 001-sandbox-providers
 *
 * Manages sandbox session timeouts with simple extension logic:
 * - +3 minutes when user sends a prompt (always extends)
 * - +2 minutes if user is active DURING the final 2 minutes before expiration
 *
 * Example: For 10-minute timeout
 * - Session expires at T=10min
 * - Danger zone: T=8min to T=10min (final 2 minutes)
 * - Only extends if user is active during this danger zone
 * - Extension resets timeout counter to prevent excessive extends without acknowledgment
 */

import type { SandboxProvider } from './types';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('TimeoutManager');

/**
 * Configuration for timeout management
 */
export interface TimeoutManagerConfig {
  /** Warning threshold in ms before timeout (default: 2 minutes) */
  warningThresholdMs: number;

  /** Check interval in ms (default: 30 seconds) */
  checkIntervalMs: number;

  /** Auto-extend on activity (default: true) */
  autoExtend: boolean;

  /** Minimum time between auto-extends in ms (default: 1 minute) */
  minAutoExtendIntervalMs: number;

  /** Callback when timeout warning should be shown */
  onWarning: (timeRemainingMs: number) => void;

  /** Callback when timeout occurs */
  onTimeout: () => void;

  /** Callback when session is extended */
  onExtended: (newTimeoutMs: number) => void;

  /** Callback to request extension (returns true if successful) */
  requestExtend: (durationMs: number) => Promise<boolean>;
}

/**
 * Timeout state
 */
export interface TimeoutState {
  /** Time remaining in ms */
  timeRemainingMs: number;

  /** Total timeout duration in ms */
  totalTimeoutMs: number;

  /** Whether warning has been shown */
  warningShown: boolean;

  /** Last activity timestamp */
  lastActivityAt: number;

  /** Whether session is expired */
  isExpired: boolean;

  /** Whether auto-extension is paused */
  autoExtendPaused: boolean;
}

/**
 * Activity record for tracking user actions
 */
interface ActivityRecord {
  timestamp: number;
  type: 'file_write' | 'command' | 'preview_access' | 'user_interaction' | 'prompt';
}

const DEFAULT_CONFIG: Partial<TimeoutManagerConfig> = {
  warningThresholdMs: 2 * 60 * 1000, // 2 minutes
  checkIntervalMs: 30 * 1000, // 30 seconds
  autoExtend: true,
  minAutoExtendIntervalMs: 60 * 1000, // 1 minute
};

// Smart extension rules
const EXTENSION_RULES = {
  prompt: 3 * 60 * 1000, // +3 minutes on prompt
  active: 2 * 60 * 1000, // +2 minutes if active during danger zone
  activityWindow: 2 * 60 * 1000, // Danger zone = final 2 minutes before expiration
};

/**
 * TimeoutManager handles sandbox session timeout tracking and management.
 *
 * Smart extension strategy:
 * - +3 minutes when user sends a prompt (immediate extend)
 * - +2 minutes when user is active during the "danger zone" (final 2 minutes before expiration)
 *
 * This prevents excessive automatic extensions and ensures users are aware when sessions extend.
 * The danger zone approach only extends when users are actively using the sandbox near expiration.
 */
export class TimeoutManager {
  private _config: TimeoutManagerConfig;
  private _provider: SandboxProvider | null = null;
  private _checkInterval: NodeJS.Timeout | null = null;
  private _state: TimeoutState;
  private _activities: ActivityRecord[] = [];
  private _lastExtendAt = 0;
  private _lastWarningAt = 0;
  private _isDisposed = false;
  private _warningResetTimeout: NodeJS.Timeout | null = null;

  constructor(config: TimeoutManagerConfig) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._state = {
      timeRemainingMs: 0,
      totalTimeoutMs: 0,
      warningShown: false,
      lastActivityAt: Date.now(),
      isExpired: false,
      autoExtendPaused: false,
    };

    logger.info('TimeoutManager initialized with simple extension rules');
  }

  /**
   * Start monitoring a sandbox provider's timeout
   */
  start(provider: SandboxProvider): void {
    if (this._isDisposed) {
      throw new Error('TimeoutManager has been disposed');
    }

    this._provider = provider;
    this._state.lastActivityAt = Date.now();
    this._lastExtendAt = Date.now();

    // Get initial timeout from provider
    const timeoutRemaining = provider.timeoutRemaining;

    if (timeoutRemaining !== null) {
      this._state.timeRemainingMs = timeoutRemaining;
      this._state.totalTimeoutMs = timeoutRemaining;
    }

    logger.info('TimeoutManager started', {
      timeRemainingMs: this._state.timeRemainingMs,
      warningThresholdMs: this._config.warningThresholdMs,
    });

    // Start periodic checks
    this._startChecking();

    // Listen for provider status changes
    provider.onStatusChange((status) => {
      if (status === 'disconnected' || status === 'error') {
        this.stop();
      }
    });
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }

    if (this._warningResetTimeout) {
      clearTimeout(this._warningResetTimeout);
      this._warningResetTimeout = null;
    }

    this._provider = null;
    logger.info('TimeoutManager stopped');
  }

  /**
   * Dispose of the manager (cannot be restarted)
   */
  dispose(): void {
    this.stop();
    this._isDisposed = true;
    this._activities = [];
  }

  /**
   * Record user activity
   * - 'prompt' triggers +3 minute extension
   * - Other activities are tracked for +2 minute active extension
   */
  recordActivity(type: ActivityRecord['type']): void {
    if (this._isDisposed || this._state.isExpired) {
      return;
    }

    const now = Date.now();
    this._state.lastActivityAt = now;

    // Record activity
    this._activities.push({
      timestamp: now,
      type,
    });

    // Clean up old activities (keep last 100)
    if (this._activities.length > 100) {
      this._activities = this._activities.slice(-100);
    }

    logger.debug('Activity recorded', { type, timeRemainingMs: this._state.timeRemainingMs });

    // Check for extension
    this._maybeAutoExtend(type);
  }

  /**
   * Pause auto-extension (user has dismissed warnings)
   */
  pauseAutoExtend(): void {
    this._state.autoExtendPaused = true;
    logger.info('Auto-extension paused');
  }

  /**
   * Resume auto-extension
   */
  resumeAutoExtend(): void {
    this._state.autoExtendPaused = false;
    logger.info('Auto-extension resumed');
  }

  /**
   * Manually request extension
   */
  async requestExtension(durationMs: number): Promise<boolean> {
    if (this._isDisposed || !this._config.requestExtend) {
      return false;
    }

    logger.info('Requesting timeout extension', { durationMs: durationMs / 60000 });

    try {
      const success = await this._config.requestExtend(durationMs);

      if (success) {
        this._lastExtendAt = Date.now();
        this._state.warningShown = false;
        this._lastWarningAt = 0;

        // Clear any pending warning reset timeout
        if (this._warningResetTimeout) {
          clearTimeout(this._warningResetTimeout);
          this._warningResetTimeout = null;
        }

        // Update state with new timeout from provider

        if (this._provider) {
          const newTimeout = this._provider.timeoutRemaining;

          if (newTimeout !== null) {
            this._state.timeRemainingMs = newTimeout;
            this._state.totalTimeoutMs = newTimeout;
          }
        }

        this._config.onExtended(durationMs);
        logger.info('Timeout extended successfully', { newTimeRemainingMs: this._state.timeRemainingMs });
      } else {
        logger.warn('Timeout extension request failed');
      }

      return success;
    } catch (error) {
      logger.error('Error requesting timeout extension', { error });
      return false;
    }
  }

  /**
   * Get current timeout state
   */
  getState(): TimeoutState {
    return { ...this._state };
  }

  /**
   * Subscribe to state changes
   */
  onStateChange(callback: (state: TimeoutState) => void): () => void {
    this._stateCallbacks.add(callback);
    return () => this._stateCallbacks.delete(callback);
  }

  /**
   * Get recent activity count
   */
  getRecentActivityCount(durationMs: number = 60000): number {
    const cutoff = Date.now() - durationMs;
    return this._activities.filter((a) => a.timestamp > cutoff).length;
  }

  /*
   * -------------------------------------------------------------------------
   * Private Methods
   * -------------------------------------------------------------------------
   */

  private _stateCallbacks: Set<(state: TimeoutState) => void> = new Set();

  private _notifyStateChange(): void {
    const state = this.getState();
    this._stateCallbacks.forEach((cb) => cb(state));
  }

  private _startChecking(): void {
    // Check immediately
    this._checkTimeout();

    // Then check periodically
    this._checkInterval = setInterval(() => {
      this._checkTimeout();
    }, this._config.checkIntervalMs);
  }

  private _checkTimeout(): void {
    if (!this._provider || this._state.isExpired) {
      return;
    }

    // Skip updating from provider if we just extended (race condition prevention)
    const timeSinceLastExtend = Date.now() - this._lastExtendAt;
    const EXTENSION_SETTLE_MS = 2000; // 2 second grace period after extension

    if (timeSinceLastExtend < EXTENSION_SETTLE_MS) {
      logger.debug('Skipping provider sync - recently extended', { timeSinceLastExtend });
      return;
    }

    // Get current timeout from provider
    const timeoutRemaining = this._provider.timeoutRemaining;

    if (timeoutRemaining === null) {
      // Provider doesn't support timeout tracking
      return;
    }

    // Update state with actual provider timeout
    this._state.timeRemainingMs = timeoutRemaining;

    // Check if expired
    if (timeoutRemaining <= 0) {
      this._handleTimeout();
      this._notifyStateChange();

      return;
    }

    // Check if we should show warning
    if (
      timeoutRemaining <= this._config.warningThresholdMs &&
      !this._state.warningShown &&
      Date.now() - this._lastWarningAt > this._config.warningThresholdMs
    ) {
      this._showWarning(timeoutRemaining);
    }

    this._notifyStateChange();
  }

  private _showWarning(timeRemainingMs: number): void {
    this._state.warningShown = true;
    this._lastWarningAt = Date.now();

    logger.info('Showing timeout warning', { timeRemainingMs });
    this._config.onWarning(timeRemainingMs);

    // Clear any existing warning reset timeout
    if (this._warningResetTimeout) {
      clearTimeout(this._warningResetTimeout);
    }

    // Reset warning flag after threshold period so it can be shown again
    this._warningResetTimeout = setTimeout(() => {
      this._state.warningShown = false;
      this._warningResetTimeout = null;
    }, this._config.warningThresholdMs);
  }

  private _handleTimeout(): void {
    this._state.isExpired = true;
    logger.info('Session timeout occurred');

    this.stop();
    this._config.onTimeout();
  }

  /**
   * Simple auto-extend logic:
   * - +3 minutes on prompt (user sends message)
   * - +2 minutes if user was active DURING the final 2 minutes before expiration (danger zone)
   *
   * Example: For 10-minute timeout
   * - Session expires at T=10min
   * - Danger zone is T=8min to T=10min (final 2 minutes)
   * - Only extends if user is active during this danger zone
   * - Extension resets the timeout counter to prevent excessive extends
   */
  private _maybeAutoExtend(activityType: ActivityRecord['type']): void {
    if (!this._config.autoExtend || this._state.autoExtendPaused || !this._config.requestExtend) {
      return;
    }

    // Check rate limiting (minimum interval between extensions)
    const timeSinceLastExtend = Date.now() - this._lastExtendAt;

    if (timeSinceLastExtend < this._config.minAutoExtendIntervalMs) {
      logger.debug('Auto-extend rate limited', { timeSinceLastExtend });
      return;
    }

    let extensionDuration = 0;
    let reason = '';

    // Rule 1: +3 minutes on prompt (always extend on user message)
    if (activityType === 'prompt') {
      extensionDuration = EXTENSION_RULES.prompt;
      reason = 'User sent prompt (+3 min)';
    } else if (this._isInDangerZone() && this._wasActiveInDangerZone()) {
      /*
       * Rule 2: +2 minutes ONLY if we're in the danger zone AND user is active
       * Danger zone = final 2 minutes before timeout
       */
      extensionDuration = EXTENSION_RULES.active;
      reason = 'User active in danger zone (final 2 min) (+2 min)';
    }

    if (extensionDuration === 0) {
      return;
    }

    logger.info('Auto-extending session', {
      duration: extensionDuration / 60000,
      timeRemaining: this._state.timeRemainingMs / 60000,
      reason,
    });

    this.requestExtension(extensionDuration)
      .then((success) => {
        if (success) {
          logger.info('Extension successful - timeout counter reset', {
            duration: extensionDuration / 60000,
            newTimeRemaining: this._state.timeRemainingMs / 60000,
          });
        } else {
          logger.warn('Extension request returned false');
        }
      })
      .catch((error) => {
        logger.error('Auto-extend failed', { error });
      });
  }

  /**
   * Check if we're currently in the danger zone (final 2 minutes before timeout)
   */
  private _isInDangerZone(): boolean {
    return this._state.timeRemainingMs <= EXTENSION_RULES.activityWindow;
  }

  /**
   * Check if user was active during the current danger zone
   * Only counts activity that happened while we were in the danger zone
   */
  private _wasActiveInDangerZone(): boolean {
    /*
     * Calculate when the danger zone started
     * If we have 1.5 minutes left, danger zone started 30 seconds ago
     */
    const dangerZoneStartedAt = Date.now() - (EXTENSION_RULES.activityWindow - this._state.timeRemainingMs);

    // Check if any activity happened after the danger zone started
    return this._activities.some((a) => a.timestamp >= dangerZoneStartedAt);
  }

  /**
   * Check if user was active in the given time window (generic helper)
   */
  private _wasActiveInWindow(windowMs: number): boolean {
    const cutoff = Date.now() - windowMs;
    return this._activities.some((a) => a.timestamp > cutoff);
  }
}

/**
 * Global timeout manager instance for the workbench
 */
let globalTimeoutManager: TimeoutManager | null = null;

/**
 * Get or create the global TimeoutManager
 */
export function getGlobalTimeoutManager(config: TimeoutManagerConfig): TimeoutManager {
  if (!globalTimeoutManager) {
    globalTimeoutManager = new TimeoutManager(config);
  }

  return globalTimeoutManager;
}

/**
 * Reset the global TimeoutManager
 */
export function resetGlobalTimeoutManager(): void {
  if (globalTimeoutManager) {
    globalTimeoutManager.dispose();
    globalTimeoutManager = null;
  }
}
