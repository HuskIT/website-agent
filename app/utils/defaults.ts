// Fallback values for when environment variables are not set
const FALLBACK_MODEL = 'kimi-for-coding';
const FALLBACK_PROVIDER_NAME = 'Moonshot';

// Read from environment (VITE_ prefix needed for client-side access)
export const DEFAULT_MODEL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEFAULT_MODEL) ||
  (typeof process !== 'undefined' && process.env?.VITE_DEFAULT_MODEL) ||
  FALLBACK_MODEL;

export const DEFAULT_PROVIDER_NAME =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEFAULT_PROVIDER_NAME) ||
  (typeof process !== 'undefined' && process.env?.VITE_DEFAULT_PROVIDER_NAME) ||
  FALLBACK_PROVIDER_NAME;
