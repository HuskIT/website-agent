import type { ActivityType, AdaptiveExtensionConfig } from './extension-config';

/**
 * Activity record with timestamp
 */
export interface ActivityRecord {
  timestamp: number;
  type: ActivityType;
}

/**
 * Activity scores across different time windows
 */
export interface ActivityScores {
  recent: number; // Last 1 minute
  short: number; // Last 5 minutes
  medium: number; // Last 15 minutes
}

/**
 * Tracks user activities with weighted scoring and exponential decay
 */
export class ActivityTracker {
  private activities: ActivityRecord[] = [];
  private config: AdaptiveExtensionConfig;

  constructor(config: AdaptiveExtensionConfig) {
    this.config = config;
  }

  /**
   * Record a new activity
   */
  recordActivity(type: ActivityType): void {
    const now = Date.now();

    this.activities.push({
      timestamp: now,
      type,
    });

    // Prune activities older than the longest time window (medium window)
    const cutoffTime = now - this.config.timeWindows.medium;
    this.activities = this.activities.filter((activity) => activity.timestamp >= cutoffTime);

    // Keep max 200 activities in memory (generous buffer)
    if (this.activities.length > 200) {
      this.activities = this.activities.slice(-200);
    }
  }

  /**
   * Calculate weighted activity score for a given time window with exponential decay
   * @param windowMs Time window in milliseconds
   * @returns Weighted activity score
   */
  getActivityScore(windowMs: number): number {
    const now = Date.now();
    const cutoffTime = now - windowMs;

    let score = 0;

    for (const activity of this.activities) {
      // Skip activities outside this window
      if (activity.timestamp < cutoffTime) {
        continue;
      }

      // Get weight for this activity type
      const weight = this.config.activityWeights[activity.type];

      // Calculate age of activity
      const age = now - activity.timestamp;

      /*
       * Apply exponential decay: e^(-age/window)
       * Recent activities count more than older ones
       */
      const decayFactor = Math.exp(-age / windowMs);

      // Add weighted score with decay
      score += weight * decayFactor;
    }

    return score;
  }

  /**
   * Get activity scores across all time windows
   */
  getActivityScores(): ActivityScores {
    return {
      recent: this.getActivityScore(this.config.timeWindows.recent),
      short: this.getActivityScore(this.config.timeWindows.short),
      medium: this.getActivityScore(this.config.timeWindows.medium),
    };
  }

  /**
   * Count raw number of activities in a time window (for debugging)
   * @param windowMs Time window in milliseconds
   * @returns Number of activities
   */
  getActivityCount(windowMs: number): number {
    const now = Date.now();
    const cutoffTime = now - windowMs;

    return this.activities.filter((activity) => activity.timestamp >= cutoffTime).length;
  }

  /**
   * Get most recent N activities (for debugging/logging)
   * @param count Number of activities to return
   * @returns Recent activities
   */
  getRecentActivities(count: number): ActivityRecord[] {
    return this.activities.slice(-count);
  }

  /**
   * Get total number of activities tracked
   */
  getTotalActivities(): number {
    return this.activities.length;
  }

  /**
   * Clear all activities (for testing or reset)
   */
  clear(): void {
    this.activities = [];
  }

  /**
   * Get activity breakdown by type in a time window
   */
  getActivityBreakdown(windowMs: number): Record<ActivityType, number> {
    const now = Date.now();
    const cutoffTime = now - windowMs;

    const breakdown: Record<ActivityType, number> = {
      user_interaction: 0,
      preview_access: 0,
    };

    for (const activity of this.activities) {
      if (activity.timestamp >= cutoffTime) {
        breakdown[activity.type]++;
      }
    }

    return breakdown;
  }
}
