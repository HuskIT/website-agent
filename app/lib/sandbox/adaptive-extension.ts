import { SessionHeat, type AdaptiveExtensionConfig } from './extension-config';
import type { ActivityTracker } from './activity-tracker';

/**
 * Extension decision result
 */
export interface ExtensionDecision {
  shouldExtend: boolean;
  reason: string;
  heat?: SessionHeat;
  duration?: number;
}

/**
 * Extension metrics for telemetry
 */
export interface ExtensionMetrics {
  sessionStartTime: number;
  sessionAge: number;
  totalExtensions: number;
  extensionsByHeat: Record<SessionHeat, number>;
  consecutiveHotExtensions: number;
  coolExtensionCount: number;
  lastExtendTime: number;
  currentHeat: SessionHeat;
  activityScores: {
    recent: number;
    short: number;
    medium: number;
  };
  timeUsed: number; // Total time elapsed since session start
  timeRemaining: number; // Time left before hitting 45min cap
}

/**
 * Core adaptive extension strategy
 */
export class AdaptiveExtensionStrategy {
  private config: AdaptiveExtensionConfig;
  private sessionStartTime: number;
  private totalExtensions: number = 0;
  private extensionsByHeat: Record<SessionHeat, number> = {
    [SessionHeat.HOT]: 0,
    [SessionHeat.WARM]: 0,
    [SessionHeat.COOL]: 0,
    [SessionHeat.COLD]: 0,
  };
  private lastExtendTime: number = 0;
  private consecutiveHotExtensions: number = 0;
  private coolExtensionCount: number = 0;
  private lastHeat: SessionHeat = SessionHeat.COLD;

  constructor(config: AdaptiveExtensionConfig) {
    this.config = config;
    this.sessionStartTime = Date.now();
  }

  /**
   * Calculate session heat based on activity scores across time windows
   */
  calculateSessionHeat(tracker: ActivityTracker): SessionHeat {
    const scores = tracker.getActivityScores();

    // Check HOT: High sustained activity
    if (
      scores.recent >= this.config.heatThresholds.hot.recent &&
      scores.short >= this.config.heatThresholds.hot.short &&
      scores.medium >= this.config.heatThresholds.hot.medium
    ) {
      return SessionHeat.HOT;
    }

    // Check WARM: Moderate activity
    if (
      scores.recent >= this.config.heatThresholds.warm.recent &&
      scores.short >= this.config.heatThresholds.warm.short &&
      scores.medium >= this.config.heatThresholds.warm.medium
    ) {
      return SessionHeat.WARM;
    }

    // Check COOL: Light activity (OR condition - any window qualifies)
    if (
      scores.recent >= this.config.heatThresholds.cool.recent ||
      scores.short >= this.config.heatThresholds.cool.short ||
      scores.medium >= this.config.heatThresholds.cool.medium
    ) {
      return SessionHeat.COOL;
    }

    // COLD: Minimal/no activity
    return SessionHeat.COLD;
  }

  /**
   * Determine if session should be extended based on decision gates
   */
  shouldExtend(timeRemainingMs: number, tracker: ActivityTracker): ExtensionDecision {
    const now = Date.now();

    // Gate 1: Extension trigger threshold - only extend when time is running low
    if (timeRemainingMs > this.config.extensionTriggerThreshold) {
      return {
        shouldExtend: false,
        reason: `Too early to extend (${(timeRemainingMs / 60000).toFixed(1)}min remaining > ${(this.config.extensionTriggerThreshold / 60000).toFixed(1)}min threshold)`,
      };
    }

    // Gate 2: Rate limiting - don't extend too frequently
    const timeSinceLastExtend = now - this.lastExtendTime;

    if (this.lastExtendTime > 0 && timeSinceLastExtend < this.config.minExtendInterval) {
      return {
        shouldExtend: false,
        reason: `Rate limited (${(timeSinceLastExtend / 1000).toFixed(0)}s since last extend < ${(this.config.minExtendInterval / 1000).toFixed(0)}s minimum)`,
      };
    }

    // Gate 3: Session lifetime cap - don't exceed maximum session lifetime
    const sessionAge = now - this.sessionStartTime;
    const timeLeftToLifetimeCap = this.config.maxSessionLifetime - sessionAge;

    if (timeLeftToLifetimeCap <= 0) {
      return {
        shouldExtend: false,
        reason: `Session lifetime cap reached (${(sessionAge / 60000).toFixed(1)}min >= ${(this.config.maxSessionLifetime / 60000).toFixed(1)}min max)`,
      };
    }

    // Gate 4: Calculate heat and check if COLD
    const heat = this.calculateSessionHeat(tracker);

    if (heat === SessionHeat.COLD) {
      return {
        shouldExtend: false,
        reason: 'Session is COLD (no meaningful activity)',
        heat,
      };
    }

    // Gate 5: Check heat-specific extension caps
    if (this.extensionsByHeat[heat] >= this.config.maxExtensions[heat]) {
      return {
        shouldExtend: false,
        reason: `${heat.toUpperCase()} extension cap reached (${this.extensionsByHeat[heat]} >= ${this.config.maxExtensions[heat]})`,
        heat,
      };
    }

    // Gate 6: Exponential backoff for COOL sessions
    if (heat === SessionHeat.COOL && this.coolExtensionCount > 0) {
      const requiredGap =
        this.config.minExtendInterval * Math.pow(this.config.backoffMultiplier, this.coolExtensionCount);

      if (timeSinceLastExtend < requiredGap) {
        return {
          shouldExtend: false,
          reason: `COOL backoff (${(timeSinceLastExtend / 1000).toFixed(0)}s < ${(requiredGap / 1000).toFixed(0)}s required for extension #${this.coolExtensionCount + 1})`,
          heat,
        };
      }
    }

    // All gates passed - extension approved
    const duration = this.getExtensionDuration(heat, timeLeftToLifetimeCap);

    return {
      shouldExtend: true,
      reason: `${heat.toUpperCase()} session (scores: ${JSON.stringify(tracker.getActivityScores())})`,
      heat,
      duration,
    };
  }

  /**
   * Calculate extension duration based on heat with streak multiplier and lifetime cap
   */
  getExtensionDuration(heat: SessionHeat, timeLeftToLifetimeCap: number): number {
    // Base duration for this heat level
    let duration = this.config.extensionDurations[heat];

    // Apply streak multiplier for consecutive HOT extensions
    if (heat === SessionHeat.HOT && this.consecutiveHotExtensions > 0) {
      const multiplier = Math.min(
        this.config.streakMultiplier.max,
        this.config.streakMultiplier.min + this.consecutiveHotExtensions * this.config.streakMultiplier.increment,
      );
      duration = Math.floor(duration * multiplier);
    }

    // Don't exceed session lifetime cap
    duration = Math.min(duration, timeLeftToLifetimeCap);

    return duration;
  }

  /**
   * Record an extension and update counters
   */
  recordExtension(heat: SessionHeat, _duration: number): void {
    this.totalExtensions++;
    this.extensionsByHeat[heat]++;
    this.lastExtendTime = Date.now();

    // Track consecutive HOT extensions
    if (heat === SessionHeat.HOT) {
      this.consecutiveHotExtensions++;
    } else {
      this.consecutiveHotExtensions = 0;
    }

    // Track COOL extension count for backoff
    if (heat === SessionHeat.COOL) {
      this.coolExtensionCount++;
    } else {
      this.coolExtensionCount = 0; // Reset if not COOL
    }

    this.lastHeat = heat;
  }

  /**
   * Reset session (called when starting a new sandbox session)
   */
  resetSession(): void {
    this.sessionStartTime = Date.now();
    this.totalExtensions = 0;
    this.extensionsByHeat = {
      [SessionHeat.HOT]: 0,
      [SessionHeat.WARM]: 0,
      [SessionHeat.COOL]: 0,
      [SessionHeat.COLD]: 0,
    };
    this.lastExtendTime = 0;
    this.consecutiveHotExtensions = 0;
    this.coolExtensionCount = 0;
    this.lastHeat = SessionHeat.COLD;
  }

  /**
   * Get current extension metrics for telemetry
   */
  getMetrics(
    currentHeat: SessionHeat,
    activityScores: { recent: number; short: number; medium: number },
  ): ExtensionMetrics {
    const now = Date.now();
    const sessionAge = now - this.sessionStartTime;
    const timeRemaining = this.config.maxSessionLifetime - sessionAge;

    return {
      sessionStartTime: this.sessionStartTime,
      sessionAge,
      totalExtensions: this.totalExtensions,
      extensionsByHeat: { ...this.extensionsByHeat },
      consecutiveHotExtensions: this.consecutiveHotExtensions,
      coolExtensionCount: this.coolExtensionCount,
      lastExtendTime: this.lastExtendTime,
      currentHeat,
      activityScores,
      timeUsed: sessionAge,
      timeRemaining: Math.max(0, timeRemaining),
    };
  }
}
