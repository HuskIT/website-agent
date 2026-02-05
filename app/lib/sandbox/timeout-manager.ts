/**
 * Timeout Manager
 * Feature: 001-sandbox-providers
 *
 * Manages sandbox session timeouts with activity tracking,
 * warning notifications, and automatic extension logic.
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
 * Activity tracking for auto-extension
 */
interface ActivityRecord {
  timestamp: number;
  type: 'file_write' | 'command' | 'preview_access' | 'user_interaction';
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

const DEFAULT_CONFIG: Partial<TimeoutManagerConfig> = {
  warningThresholdMs: 2 * 60 * 1000, // 2 minutes
  checkIntervalMs: 30 * 1000, // 30 seconds
  autoExtend: true,
  minAutoExtendIntervalMs: 60 * 1000, // 1 minute
};

/**
 * TimeoutManager handles sandbox session timeout tracking and management.
 *
 * Features:
 * - Tracks time remaining via provider status
 * - Shows warning before timeout
 * - Auto-extends on user activity
 * - Handles timeout expiration
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
   * Record user activity (triggers auto-extend if enabled)
   */
  recordActivity(type: ActivityRecord['type']): void {
    if (this._isDisposed || this._state.isExpired) {
      return;
    }

    const now = Date.now();
    this._state.lastActivityAt = now;

    this._activities.push({
      timestamp: now,
      type,
    });

    // Clean up old activities (keep last 100)
    if (this._activities.length > 100) {
      this._activities = this._activities.slice(-100);
    }

    logger.debug('Activity recorded', { type, timeRemainingMs: this._state.timeRemainingMs });

    // Trigger auto-extend if conditions are met
    this._maybeAutoExtend();
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

    logger.info('Requesting timeout extension', { durationMs });

    try {
      const success = await this._config.requestExtend(durationMs);

      if (success) {
        this._lastExtendAt = Date.now();
        this._state.warningShown = false;
        this._lastWarningAt = 0;

        // Update state with new timeout
        this._state.timeRemainingMs += durationMs;
        this._state.totalTimeoutMs = this._state.timeRemainingMs;

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

    // Get current timeout from provider
    const timeoutRemaining = this._provider.timeoutRemaining;

    if (timeoutRemaining === null) {
      // Provider doesn't support timeout tracking
      return;
    }

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

    // Reset warning flag after threshold period so it can be shown again
    setTimeout(() => {
      this._state.warningShown = false;
    }, this._config.warningThresholdMs);
  }

  private _handleTimeout(): void {
    this._state.isExpired = true;
    logger.info('Session timeout occurred');

    this.stop();
    this._config.onTimeout();
  }

  private _maybeAutoExtend(): void {
    if (!this._config.autoExtend || this._state.autoExtendPaused || !this._config.requestExtend) {
      return;
    }

    const now = Date.now();

    // Don't auto-extend too frequently
    if (now - this._lastExtendAt < this._config.minAutoExtendIntervalMs) {
      return;
    }

    // Only auto-extend if time is running low
    if (this._state.timeRemainingMs > this._config.warningThresholdMs * 2) {
      return;
    }

    // Check if there's been meaningful activity
    const recentActivity = this.getRecentActivityCount(60000);

    if (recentActivity < 3) {
      // Not enough activity to justify auto-extend
      return;
    }

    // Request extension (5 minutes)
    const extendDuration = 5 * 60 * 1000;
    logger.info('Auto-extending session due to activity', { recentActivity, extendDuration });

    this.requestExtension(extendDuration).catch((error) => {
      logger.error('Auto-extend failed', { error });
    });
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
