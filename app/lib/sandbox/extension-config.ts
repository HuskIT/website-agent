import { z } from 'zod';

/**
 * Activity types tracked for extension decisions
 */
export type ActivityType = 'user_interaction' | 'preview_access';

/**
 * Session heat states based on activity levels
 */
export enum SessionHeat {
  HOT = 'hot',
  WARM = 'warm',
  COOL = 'cool',
  COLD = 'cold',
}

/**
 * Configuration schema for adaptive extension algorithm
 */
export const AdaptiveExtensionConfigSchema = z.object({
  // Activity weights (non-technical users: only user_interaction and preview_access)
  activityWeights: z.object({
    user_interaction: z.number().min(0).default(1.0),
    preview_access: z.number().min(0).default(0.8),
  }),

  // Time windows for activity analysis (in milliseconds)
  timeWindows: z.object({
    recent: z.number().int().min(1000).default(60_000), // 1 minute
    short: z.number().int().min(1000).default(300_000), // 5 minutes
    medium: z.number().int().min(1000).default(900_000), // 15 minutes
  }),

  // Heat state thresholds (activity scores required for each state)
  heatThresholds: z.object({
    hot: z.object({
      recent: z.number().min(0).default(6),
      short: z.number().min(0).default(12),
      medium: z.number().min(0).default(20),
    }),
    warm: z.object({
      recent: z.number().min(0).default(3),
      short: z.number().min(0).default(6),
      medium: z.number().min(0).default(10),
    }),
    cool: z.object({
      recent: z.number().min(0).default(1.5),
      short: z.number().min(0).default(3),
      medium: z.number().min(0).default(5),
    }),
  }),

  // Extension durations by heat state (in milliseconds)
  extensionDurations: z.object({
    hot: z
      .number()
      .int()
      .min(0)
      .default(10 * 60 * 1000), // 10 minutes
    warm: z
      .number()
      .int()
      .min(0)
      .default(7 * 60 * 1000), // 7 minutes
    cool: z
      .number()
      .int()
      .min(0)
      .default(3 * 60 * 1000), // 3 minutes
    cold: z.number().int().min(0).default(0), // No extension
  }),

  // Maximum extensions per heat state
  maxExtensions: z.object({
    hot: z.number().int().min(0).default(3), // Max 3 HOT = 30min
    warm: z.number().int().min(0).default(4), // Max 4 WARM = 28min
    cool: z.number().int().min(0).default(11), // Max 11 COOL = 33min
  }),

  // Rate limiting
  minExtendInterval: z.number().int().min(0).default(60_000), // 1 minute between extensions

  // Extension trigger threshold (extend when time remaining ≤ this value)
  extensionTriggerThreshold: z
    .number()
    .int()
    .min(0)
    .default(4 * 60 * 1000), // 4 minutes

  // Session limits
  initialTimeout: z
    .number()
    .int()
    .min(0)
    .default(10 * 60 * 1000), // 10 minutes
  maxSessionLifetime: z
    .number()
    .int()
    .min(0)
    .default(45 * 60 * 1000), // 45 minutes (Vercel limit)

  // Backoff configuration
  backoffMultiplier: z.number().min(1).default(1.5), // Exponential backoff for COOL sessions
  streakMultiplier: z.object({
    min: z.number().min(0).default(1.0),
    max: z.number().min(0).default(1.2),
    increment: z.number().min(0).default(0.05),
  }),
});

export type AdaptiveExtensionConfig = z.infer<typeof AdaptiveExtensionConfigSchema>;

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: AdaptiveExtensionConfig = {
  activityWeights: {
    user_interaction: 1.0,
    preview_access: 0.8,
  },
  timeWindows: {
    recent: 60_000, // 1 minute
    short: 300_000, // 5 minutes
    medium: 900_000, // 15 minutes
  },
  heatThresholds: {
    hot: { recent: 6, short: 12, medium: 20 },
    warm: { recent: 3, short: 6, medium: 10 },
    cool: { recent: 1.5, short: 3, medium: 5 },
  },
  extensionDurations: {
    hot: 10 * 60 * 1000, // 10 min
    warm: 7 * 60 * 1000, // 7 min
    cool: 3 * 60 * 1000, // 3 min
    cold: 0,
  },
  maxExtensions: {
    hot: 3,
    warm: 4,
    cool: 11,
  },
  minExtendInterval: 60_000, // 1 minute
  extensionTriggerThreshold: 4 * 60 * 1000, // 4 minutes
  initialTimeout: 10 * 60 * 1000, // 10 minutes
  maxSessionLifetime: 45 * 60 * 1000, // 45 minutes
  backoffMultiplier: 1.5,
  streakMultiplier: {
    min: 1.0,
    max: 1.2,
    increment: 0.05,
  },
};

/**
 * Get environment variable from Vite's import.meta.env or process.env
 */
function getEnvVar(name: string): string | undefined {
  // Vite exposes env vars via import.meta.env
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    return import.meta.env[name] as string | undefined;
  }

  // Fallback to process.env for Node.js/server-side
  if (typeof process !== 'undefined' && process.env) {
    return process.env[name];
  }

  return undefined;
}

/**
 * Load configuration from environment variables with defaults
 */
export function loadConfig(overrides?: Partial<AdaptiveExtensionConfig>): AdaptiveExtensionConfig {
  const envConfig: Partial<AdaptiveExtensionConfig> = {};

  // Load from environment variables (Vite exposes SANDBOX_ prefixed vars)
  const hotDuration = getEnvVar('SANDBOX_EXTENSION_HOT_DURATION');

  if (hotDuration) {
    envConfig.extensionDurations = {
      ...DEFAULT_CONFIG.extensionDurations,
      hot: parseInt(hotDuration, 10),
    };
  }

  const warmDuration = getEnvVar('SANDBOX_EXTENSION_WARM_DURATION');

  if (warmDuration) {
    envConfig.extensionDurations = {
      ...DEFAULT_CONFIG.extensionDurations,
      ...envConfig.extensionDurations,
      warm: parseInt(warmDuration, 10),
    };
  }

  const coolDuration = getEnvVar('SANDBOX_EXTENSION_COOL_DURATION');

  if (coolDuration) {
    envConfig.extensionDurations = {
      ...DEFAULT_CONFIG.extensionDurations,
      ...envConfig.extensionDurations,
      cool: parseInt(coolDuration, 10),
    };
  }

  const maxHot = getEnvVar('SANDBOX_EXTENSION_MAX_HOT');
  const maxWarm = getEnvVar('SANDBOX_EXTENSION_MAX_WARM');
  const maxCool = getEnvVar('SANDBOX_EXTENSION_MAX_COOL');

  if (maxHot || maxWarm || maxCool) {
    envConfig.maxExtensions = {
      hot: maxHot ? parseInt(maxHot, 10) : DEFAULT_CONFIG.maxExtensions.hot,
      warm: maxWarm ? parseInt(maxWarm, 10) : DEFAULT_CONFIG.maxExtensions.warm,
      cool: maxCool ? parseInt(maxCool, 10) : DEFAULT_CONFIG.maxExtensions.cool,
    };
  }

  const maxLifetime = getEnvVar('SANDBOX_SESSION_MAX_LIFETIME');

  if (maxLifetime) {
    envConfig.maxSessionLifetime = parseInt(maxLifetime, 10);
  }

  const initialTimeout = getEnvVar('SANDBOX_INITIAL_TIMEOUT');

  if (initialTimeout) {
    envConfig.initialTimeout = parseInt(initialTimeout, 10);
  }

  // Merge: defaults < env < overrides
  const merged = {
    ...DEFAULT_CONFIG,
    ...envConfig,
    ...overrides,
  };

  // Validate with Zod schema
  return AdaptiveExtensionConfigSchema.parse(merged);
}
