/**
 * Timeout Manager
 * Feature: 001-sandbox-providers
 *
 * Manages sandbox session timeouts with activity tracking,
 * warning notifications, and automatic extension logic.
 */

import type { SandboxProvider } from './types';
import { createScopedLogger } from '~/utils/logger';
import { ActivityTracker } from './activity-tracker';
import { AdaptiveExtensionStrategy } from './adaptive-extension';
import { loadConfig, type AdaptiveExtensionConfig } from './extension-config';
import type { ActivityType } from './extension-config';

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
 * Note: Kept for backwards compatibility, but adaptive extension uses ActivityType from extension-config
 */
interface ActivityRecord {
  timestamp: number;
  type: ActivityType | 'file_write' | 'command'; // Legacy types for backwards compatibility
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
  private _warningResetTimeout: NodeJS.Timeout | null = null;

  // Adaptive extension strategy
  private _adaptiveStrategy: AdaptiveExtensionStrategy;
  private _activityTracker: ActivityTracker;
  private _adaptiveConfig: AdaptiveExtensionConfig;

  constructor(config: TimeoutManagerConfig, adaptiveConfig?: Partial<AdaptiveExtensionConfig>) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._state = {
      timeRemainingMs: 0,
      totalTimeoutMs: 0,
      warningShown: false,
      lastActivityAt: Date.now(),
      isExpired: false,
      autoExtendPaused: false,
    };

    // Initialize adaptive extension strategy
    this._adaptiveConfig = loadConfig(adaptiveConfig);
    this._adaptiveStrategy = new AdaptiveExtensionStrategy(this._adaptiveConfig);
    this._activityTracker = new ActivityTracker(this._adaptiveConfig);

    logger.info('TimeoutManager initialized with adaptive extension', {
      hotDuration: this._adaptiveConfig.extensionDurations.hot / 60000,
      warmDuration: this._adaptiveConfig.extensionDurations.warm / 60000,
      coolDuration: this._adaptiveConfig.extensionDurations.cool / 60000,
      maxLifetime: this._adaptiveConfig.maxSessionLifetime / 60000,
    });
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
   * Record user activity (triggers auto-extend if enabled)
   */
  recordActivity(type: ActivityRecord['type']): void {
    if (this._isDisposed || this._state.isExpired) {
      return;
    }

    const now = Date.now();
    this._state.lastActivityAt = now;

    // Legacy activity tracking (kept for backwards compatibility)
    this._activities.push({
      timestamp: now,
      type,
    });

    // Clean up old activities (keep last 100)
    if (this._activities.length > 100) {
      this._activities = this._activities.slice(-100);
    }

    // Track in adaptive activity tracker (only user_interaction and preview_access)
    if (type === 'user_interaction' || type === 'preview_access') {
      this._activityTracker.recordActivity(type as ActivityType);
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

        // Clear any pending warning reset timeout
        if (this._warningResetTimeout) {
          clearTimeout(this._warningResetTimeout);
          this._warningResetTimeout = null;
        }

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

  private _maybeAutoExtend(): void {
    if (!this._config.autoExtend || this._state.autoExtendPaused || !this._config.requestExtend) {
      return;
    }

    // Use adaptive extension strategy
    const decision = this._adaptiveStrategy.shouldExtend(this._state.timeRemainingMs, this._activityTracker);

    if (!decision.shouldExtend) {
      logger.debug('Auto-extend skipped', { reason: decision.reason });
      return;
    }

    const { heat, duration } = decision;

    if (!heat || !duration) {
      logger.warn('Auto-extend approved but missing heat or duration', { decision });
      return;
    }

    logger.info('Auto-extending session', {
      heat,
      duration: duration / 60000,
      reason: decision.reason,
      scores: this._activityTracker.getActivityScores(),
      metrics: this._adaptiveStrategy.getMetrics(heat, this._activityTracker.getActivityScores()),
    });

    this.requestExtension(duration)
      .then((success) => {
        if (success) {
          this._adaptiveStrategy.recordExtension(heat, duration);
          this._lastExtendAt = Date.now();
          logger.info('Extension successful', {
            heat,
            duration: duration / 60000,
            newTimeRemaining: this._state.timeRemainingMs / 60000,
          });
        } else {
          logger.warn('Extension request returned false', { heat, duration });
        }
      })
      .catch((error) => {
        logger.error('Auto-extend failed', { error, heat, duration });
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
