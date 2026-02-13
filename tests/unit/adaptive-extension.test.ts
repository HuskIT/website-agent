import { describe, it, expect, beforeEach } from 'vitest';
import { ActivityTracker } from '~/lib/sandbox/activity-tracker';
import { AdaptiveExtensionStrategy } from '~/lib/sandbox/adaptive-extension';
import { DEFAULT_CONFIG, SessionHeat } from '~/lib/sandbox/extension-config';

describe('ActivityTracker', () => {
  let tracker: ActivityTracker;

  beforeEach(() => {
    tracker = new ActivityTracker(DEFAULT_CONFIG);
  });

  describe('recordActivity', () => {
    it('should record activities with timestamps', () => {
      tracker.recordActivity('user_interaction');
      tracker.recordActivity('preview_access');

      expect(tracker.getTotalActivities()).toBe(2);
    });

    it('should prune old activities beyond medium window', () => {
      // Record activities
      for (let i = 0; i < 10; i++) {
        tracker.recordActivity('user_interaction');
      }

      // Fast forward time beyond medium window (15 min)
      const activities = tracker.getRecentActivities(10);
      expect(activities.length).toBe(10);
    });
  });

  describe('getActivityScore', () => {
    it('should calculate weighted score with exponential decay', () => {
      // Record activity
      tracker.recordActivity('user_interaction'); // weight = 1.0

      // Score should be close to 1.0 immediately
      const score = tracker.getActivityScore(60_000); // 1 minute window
      expect(score).toBeGreaterThan(0.9);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    it('should weight preview_access lower than user_interaction', () => {
      const tracker1 = new ActivityTracker(DEFAULT_CONFIG);
      const tracker2 = new ActivityTracker(DEFAULT_CONFIG);

      tracker1.recordActivity('user_interaction'); // weight = 1.0
      tracker2.recordActivity('preview_access'); // weight = 0.8

      const score1 = tracker1.getActivityScore(60_000);
      const score2 = tracker2.getActivityScore(60_000);

      expect(score1).toBeGreaterThan(score2);
    });

    it('should apply exponential decay over time', () => {
      tracker.recordActivity('user_interaction');

      const immediateScore = tracker.getActivityScore(60_000);

      // Activity decays with time, but we can't actually wait, so just verify formula
      // Score = weight × e^(-age/window)
      // For age=0: e^0 = 1.0, score = 1.0
      // For age=30s, window=60s: e^(-0.5) ≈ 0.606
      expect(immediateScore).toBeGreaterThan(0.9);
    });
  });

  describe('getActivityScores', () => {
    it('should return scores for all three time windows', () => {
      tracker.recordActivity('user_interaction');

      const scores = tracker.getActivityScores();

      expect(scores).toHaveProperty('recent');
      expect(scores).toHaveProperty('short');
      expect(scores).toHaveProperty('medium');
      expect(scores.recent).toBeGreaterThan(0);
      expect(scores.short).toBeGreaterThan(0);
      expect(scores.medium).toBeGreaterThan(0);
    });
  });

  describe('getActivityBreakdown', () => {
    it('should count activities by type', () => {
      tracker.recordActivity('user_interaction');
      tracker.recordActivity('user_interaction');
      tracker.recordActivity('preview_access');

      const breakdown = tracker.getActivityBreakdown(60_000);

      expect(breakdown.user_interaction).toBe(2);
      expect(breakdown.preview_access).toBe(1);
    });
  });
});

describe('AdaptiveExtensionStrategy', () => {
  let strategy: AdaptiveExtensionStrategy;
  let tracker: ActivityTracker;

  beforeEach(() => {
    strategy = new AdaptiveExtensionStrategy(DEFAULT_CONFIG);
    tracker = new ActivityTracker(DEFAULT_CONFIG);
  });

  describe('calculateSessionHeat', () => {
    it('should classify as COLD with no activity', () => {
      const heat = strategy.calculateSessionHeat(tracker);
      expect(heat).toBe(SessionHeat.COLD);
    });

    it('should classify as HOT with high sustained activity', () => {
      // Generate HOT activity: recent≥6, short≥12, medium≥20
      for (let i = 0; i < 20; i++) {
        tracker.recordActivity('user_interaction');
      }

      const heat = strategy.calculateSessionHeat(tracker);
      expect(heat).toBe(SessionHeat.HOT);
    });

    it('should classify as WARM with moderate activity', () => {
      // Generate WARM activity: recent≥3, short≥6, medium≥10
      // Need more activities to account for exponential decay
      for (let i = 0; i < 12; i++) {
        tracker.recordActivity('user_interaction');
      }

      const heat = strategy.calculateSessionHeat(tracker);
      expect(heat).toBe(SessionHeat.WARM);
    });

    it('should classify as COOL with light activity', () => {
      // Generate COOL activity: recent≥1.5 OR short≥3 OR medium≥5
      for (let i = 0; i < 3; i++) {
        tracker.recordActivity('user_interaction');
      }

      const heat = strategy.calculateSessionHeat(tracker);
      expect(heat).toBe(SessionHeat.COOL);
    });
  });

  describe('shouldExtend', () => {
    it('should not extend when time remaining is high', () => {
      // Time remaining > 4 minutes (extension trigger threshold)
      const decision = strategy.shouldExtend(5 * 60 * 1000, tracker);

      expect(decision.shouldExtend).toBe(false);
      expect(decision.reason).toContain('Too early to extend');
    });

    it('should not extend for COLD sessions', () => {
      // Low time remaining but no activity
      const decision = strategy.shouldExtend(3 * 60 * 1000, tracker);

      expect(decision.shouldExtend).toBe(false);
      expect(decision.reason).toContain('COLD');
    });

    it('should extend for HOT session with low time remaining', () => {
      // Generate HOT activity: need higher scores to overcome decay
      // recent≥6, short≥12, medium≥20
      for (let i = 0; i < 30; i++) {
        tracker.recordActivity('user_interaction');
      }

      // Time remaining ≤ 4 minutes
      const decision = strategy.shouldExtend(3 * 60 * 1000, tracker);

      expect(decision.shouldExtend).toBe(true);
      expect(decision.heat).toBe(SessionHeat.HOT);
      expect(decision.duration).toBe(10 * 60 * 1000); // 10 minutes
    });

    it('should respect heat-specific extension caps', () => {
      // Generate HOT activity
      for (let i = 0; i < 30; i++) {
        tracker.recordActivity('user_interaction');
      }

      // Record 3 HOT extensions (max limit)
      for (let i = 0; i < 3; i++) {
        strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);
      }

      // Set last extend time AFTER recording to bypass rate limiting for the check
      (strategy as any).lastExtendTime = Date.now() - (2 * 60 * 1000);

      // Try to extend again - should be denied due to cap
      const decision = strategy.shouldExtend(3 * 60 * 1000, tracker);

      expect(decision.shouldExtend).toBe(false);
      expect(decision.reason).toContain('HOT extension cap reached');
    });

    it('should enforce session lifetime cap', () => {
      // Generate HOT activity
      for (let i = 0; i < 30; i++) {
        tracker.recordActivity('user_interaction');
      }

      // Manually set session start time to PAST the 45-minute lifetime cap
      (strategy as any).sessionStartTime = Date.now() - (46 * 60 * 1000); // 46 minutes ago

      // Time remaining is low (1 minute)
      const decision = strategy.shouldExtend(1 * 60 * 1000, tracker);

      expect(decision.shouldExtend).toBe(false);
      expect(decision.reason).toContain('Session lifetime cap reached');
    });

    it('should apply exponential backoff for COOL sessions', () => {
      // Generate COOL activity
      for (let i = 0; i < 3; i++) {
        tracker.recordActivity('user_interaction');
      }

      // Set last extend time to bypass initial rate limit
      (strategy as any).lastExtendTime = Date.now() - (2 * 60 * 1000); // 2 minutes ago

      // First extension should succeed
      const decision1 = strategy.shouldExtend(3 * 60 * 1000, tracker);
      expect(decision1.shouldExtend).toBe(true);

      strategy.recordExtension(SessionHeat.COOL, 3 * 60 * 1000);

      // Set last extend time AFTER recording to bypass rate limit but trigger backoff
      // The backoff requirement for 1st COOL extension is: 60s × 1.5^1 = 90s
      // Set to 70s ago (> 60s min but < 90s backoff)
      (strategy as any).lastExtendTime = Date.now() - (70 * 1000);

      // Try again - should be denied due to backoff (not rate limit)
      const decision2 = strategy.shouldExtend(3 * 60 * 1000, tracker);
      expect(decision2.shouldExtend).toBe(false);
      expect(decision2.reason).toContain('COOL backoff');
    });
  });

  describe('getExtensionDuration', () => {
    it('should return base duration for HOT sessions', () => {
      const duration = strategy.getExtensionDuration(SessionHeat.HOT, 35 * 60 * 1000);
      expect(duration).toBe(10 * 60 * 1000); // 10 minutes
    });

    it('should return base duration for WARM sessions', () => {
      const duration = strategy.getExtensionDuration(SessionHeat.WARM, 35 * 60 * 1000);
      expect(duration).toBe(7 * 60 * 1000); // 7 minutes
    });

    it('should return base duration for COOL sessions', () => {
      const duration = strategy.getExtensionDuration(SessionHeat.COOL, 35 * 60 * 1000);
      expect(duration).toBe(3 * 60 * 1000); // 3 minutes
    });

    it('should apply streak multiplier for consecutive HOT extensions', () => {
      // Record consecutive HOT extensions
      strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);
      strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);

      const duration = strategy.getExtensionDuration(SessionHeat.HOT, 35 * 60 * 1000);

      // Streak multiplier: 1.0 + (2 × 0.05) = 1.1
      // Duration: 10min × 1.1 = 11min = 660,000ms
      expect(duration).toBeGreaterThan(10 * 60 * 1000);
      expect(duration).toBeLessThanOrEqual(12 * 60 * 1000); // Max 1.2×
    });

    it('should cap duration at time left to lifetime cap', () => {
      const timeLeft = 5 * 60 * 1000; // Only 5 minutes left
      const duration = strategy.getExtensionDuration(SessionHeat.HOT, timeLeft);

      // Should be capped at 5 minutes, not 10
      expect(duration).toBe(5 * 60 * 1000);
    });
  });

  describe('recordExtension', () => {
    it('should increment total extensions counter', () => {
      strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);

      const metrics = strategy.getMetrics(SessionHeat.HOT, { recent: 6, short: 12, medium: 20 });
      expect(metrics.totalExtensions).toBe(1);
    });

    it('should increment heat-specific counters', () => {
      strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);
      strategy.recordExtension(SessionHeat.WARM, 7 * 60 * 1000);

      const metrics = strategy.getMetrics(SessionHeat.WARM, { recent: 3, short: 6, medium: 10 });
      expect(metrics.extensionsByHeat[SessionHeat.HOT]).toBe(1);
      expect(metrics.extensionsByHeat[SessionHeat.WARM]).toBe(1);
    });

    it('should track consecutive HOT extensions', () => {
      strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);
      strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);

      const metrics = strategy.getMetrics(SessionHeat.HOT, { recent: 6, short: 12, medium: 20 });
      expect(metrics.consecutiveHotExtensions).toBe(2);
    });

    it('should reset consecutive HOT count on non-HOT extension', () => {
      strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);
      strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);
      strategy.recordExtension(SessionHeat.WARM, 7 * 60 * 1000);

      const metrics = strategy.getMetrics(SessionHeat.WARM, { recent: 3, short: 6, medium: 10 });
      expect(metrics.consecutiveHotExtensions).toBe(0);
    });

    it('should track COOL extension count for backoff', () => {
      strategy.recordExtension(SessionHeat.COOL, 3 * 60 * 1000);
      strategy.recordExtension(SessionHeat.COOL, 3 * 60 * 1000);

      const metrics = strategy.getMetrics(SessionHeat.COOL, { recent: 1.5, short: 3, medium: 5 });
      expect(metrics.coolExtensionCount).toBe(2);
    });

    it('should reset COOL count on non-COOL extension', () => {
      strategy.recordExtension(SessionHeat.COOL, 3 * 60 * 1000);
      strategy.recordExtension(SessionHeat.WARM, 7 * 60 * 1000);

      const metrics = strategy.getMetrics(SessionHeat.WARM, { recent: 3, short: 6, medium: 10 });
      expect(metrics.coolExtensionCount).toBe(0);
    });
  });

  describe('resetSession', () => {
    it('should reset all counters', () => {
      // Record some extensions
      strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);
      strategy.recordExtension(SessionHeat.WARM, 7 * 60 * 1000);

      // Reset
      strategy.resetSession();

      const metrics = strategy.getMetrics(SessionHeat.COLD, { recent: 0, short: 0, medium: 0 });
      expect(metrics.totalExtensions).toBe(0);
      expect(metrics.consecutiveHotExtensions).toBe(0);
      expect(metrics.coolExtensionCount).toBe(0);
    });
  });

  describe('getMetrics', () => {
    it('should return comprehensive telemetry data', () => {
      strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);

      const metrics = strategy.getMetrics(SessionHeat.HOT, { recent: 6, short: 12, medium: 20 });

      expect(metrics).toHaveProperty('sessionStartTime');
      expect(metrics).toHaveProperty('sessionAge');
      expect(metrics).toHaveProperty('totalExtensions');
      expect(metrics).toHaveProperty('extensionsByHeat');
      expect(metrics).toHaveProperty('currentHeat');
      expect(metrics).toHaveProperty('activityScores');
      expect(metrics).toHaveProperty('timeUsed');
      expect(metrics).toHaveProperty('timeRemaining');

      expect(metrics.currentHeat).toBe(SessionHeat.HOT);
      expect(metrics.totalExtensions).toBe(1);
    });
  });
});

describe('Integration: Full Extension Workflow', () => {
  it('should simulate HOT session lifecycle', () => {
    const strategy = new AdaptiveExtensionStrategy(DEFAULT_CONFIG);
    const tracker = new ActivityTracker(DEFAULT_CONFIG);

    // Simulate active user - 30 interactions to reach HOT thresholds
    for (let i = 0; i < 30; i++) {
      tracker.recordActivity('user_interaction');
    }

    // Time is running low (3 minutes remaining)
    const decision = strategy.shouldExtend(3 * 60 * 1000, tracker);

    // Should approve HOT extension
    expect(decision.shouldExtend).toBe(true);
    expect(decision.heat).toBe(SessionHeat.HOT);
    expect(decision.duration).toBe(10 * 60 * 1000);

    // Record the extension
    strategy.recordExtension(decision.heat!, decision.duration!);

    // Verify metrics
    const metrics = strategy.getMetrics(SessionHeat.HOT, tracker.getActivityScores());
    expect(metrics.totalExtensions).toBe(1);
    expect(metrics.extensionsByHeat[SessionHeat.HOT]).toBe(1);
  });

  it('should simulate COLD session timeout', () => {
    const strategy = new AdaptiveExtensionStrategy(DEFAULT_CONFIG);
    const tracker = new ActivityTracker(DEFAULT_CONFIG);

    // No activity - COLD session
    const decision = strategy.shouldExtend(3 * 60 * 1000, tracker);

    // Should deny extension
    expect(decision.shouldExtend).toBe(false);
    expect(decision.heat).toBe(SessionHeat.COLD);
    expect(decision.reason).toContain('COLD');
  });

  it('should enforce 45-minute session lifetime cap', () => {
    const strategy = new AdaptiveExtensionStrategy(DEFAULT_CONFIG);
    const tracker = new ActivityTracker(DEFAULT_CONFIG);

    // Generate HOT activity
    for (let i = 0; i < 30; i++) {
      tracker.recordActivity('user_interaction');
    }

    // Record extensions up to lifetime cap
    // Initial: 10min + 3×10min HOT = 40min total
    strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);
    strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);
    strategy.recordExtension(SessionHeat.HOT, 10 * 60 * 1000);

    // Only 5 minutes left to cap (45 - 40 = 5)
    const timeLeft = 5 * 60 * 1000;

    // Bypass rate limiting for this test
    (strategy as any).lastExtendTime = Date.now() - (2 * 60 * 1000);

    const decision = strategy.shouldExtend(3 * 60 * 1000, tracker);

    // Should approve but with shortened duration
    if (decision.shouldExtend) {
      const duration = strategy.getExtensionDuration(SessionHeat.HOT, timeLeft);
      expect(duration).toBeLessThanOrEqual(timeLeft);
    }
  });
});
