/**
 * Timeout Warning Component
 * Feature: 001-sandbox-providers
 *
 * Displays a warning toast when the sandbox session is about to expire,
 * with options to extend the session or dismiss the warning.
 */

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { workbenchStore } from '~/lib/stores/workbench';
import { classNames } from '~/utils/classNames';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('TimeoutWarning');

interface TimeoutWarningProps {
  /** Time remaining in milliseconds */
  timeRemainingMs: number;

  /** Whether the warning is visible */
  isVisible: boolean;

  /** Callback when user requests extension */
  onExtend: () => void;

  /** Callback when user dismisses the warning */
  onDismiss: () => void;
}

/**
 * Format milliseconds into a human-readable time string
 */
function formatTimeRemaining(ms: number): string {
  if (ms <= 0) {
    return '0:00';
  }

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);

  if (minutes > 0) {
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  return `${seconds}s`;
}

/**
 * TimeoutWarning displays a non-intrusive warning when the sandbox session
 * is about to expire. It provides quick actions to extend the session.
 */
export function TimeoutWarning({ timeRemainingMs, isVisible, onExtend: _onExtend, onDismiss }: TimeoutWarningProps) {
  const [isExtending, setIsExtending] = useState(false);
  const [extendError, setExtendError] = useState<string | null>(null);

  // Clear error when visibility changes
  useEffect(() => {
    if (isVisible) {
      setExtendError(null);
    }
  }, [isVisible]);

  const handleExtend = useCallback(async () => {
    setIsExtending(true);
    setExtendError(null);

    try {
      const success = await workbenchStore.requestTimeoutExtension(5 * 60 * 1000); // 5 minutes

      if (success) {
        logger.info('Session extended successfully');
        onDismiss();
      } else {
        setExtendError('Failed to extend session. Please try again.');
      }
    } catch (error) {
      logger.error('Error extending session', { error });
      setExtendError('An error occurred. Please try again.');
    } finally {
      setIsExtending(false);
    }
  }, [onDismiss]);

  // Determine urgency level for styling
  const urgencyLevel = timeRemainingMs < 60000 ? 'critical' : timeRemainingMs < 120000 ? 'warning' : 'info';

  const urgencyStyles = {
    critical: 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400',
    warning: 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400',
    info: 'bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400',
  };

  const buttonStyles = {
    critical: 'bg-red-500 hover:bg-red-600 text-white',
    warning: 'bg-amber-500 hover:bg-amber-600 text-white',
    info: 'bg-blue-500 hover:bg-blue-600 text-white',
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: -20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className={classNames(
            'fixed top-4 right-4 z-50 max-w-sm w-full',
            'rounded-xl border shadow-lg backdrop-blur-sm',
            urgencyStyles[urgencyLevel],
          )}
          role="alert"
          aria-live="polite"
        >
          <div className="p-4">
            <div className="flex items-start gap-3">
              {/* Icon */}
              <div className="flex-shrink-0 mt-0.5">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold mb-1">Session Expiring Soon</h3>
                <p className="text-sm opacity-90 mb-3">
                  Your sandbox session will expire in{' '}
                  <span className="font-mono font-medium">{formatTimeRemaining(timeRemainingMs)}</span>. Save your work
                  or extend the session.
                </p>

                {extendError && <p className="text-xs text-red-500 dark:text-red-400 mb-3">{extendError}</p>}

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleExtend}
                    disabled={isExtending}
                    className={classNames(
                      'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      buttonStyles[urgencyLevel],
                    )}
                  >
                    {isExtending ? (
                      <span className="flex items-center gap-1.5">
                        <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                            fill="none"
                          />
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          />
                        </svg>
                        Extending...
                      </span>
                    ) : (
                      'Extend Session'
                    )}
                  </button>

                  <button
                    onClick={onDismiss}
                    disabled={isExtending}
                    className={classNames(
                      'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                      'hover:bg-black/5 dark:hover:bg-white/10',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                  >
                    Dismiss
                  </button>
                </div>
              </div>

              {/* Close button */}
              <button
                onClick={onDismiss}
                disabled={isExtending}
                className="flex-shrink-0 -mr-1 -mt-1 p-1 rounded-lg opacity-60 hover:opacity-100 transition-opacity disabled:opacity-30"
                aria-label="Close warning"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Progress bar showing time remaining */}
          <div className="h-1 bg-black/10 dark:bg-white/10 rounded-b-xl overflow-hidden">
            <motion.div
              className={classNames('h-full', buttonStyles[urgencyLevel].split(' ')[0])}
              initial={{ width: '100%' }}
              animate={{ width: `${Math.max(0, Math.min(100, (timeRemainingMs / 120000) * 100))}%` }}
              transition={{ duration: 1, ease: 'linear' }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Hook to manage timeout warning state
 */
export function useTimeoutWarning() {
  const [warningState, setWarningState] = useState<{
    isVisible: boolean;
    timeRemainingMs: number;
  }>({
    isVisible: false,
    timeRemainingMs: 0,
  });

  const showWarning = useCallback((timeRemainingMs: number) => {
    setWarningState({
      isVisible: true,
      timeRemainingMs,
    });
  }, []);

  const hideWarning = useCallback(() => {
    setWarningState((prev) => ({
      ...prev,
      isVisible: false,
    }));
  }, []);

  const updateTimeRemaining = useCallback((timeRemainingMs: number) => {
    setWarningState((prev) => ({
      ...prev,
      timeRemainingMs,
    }));
  }, []);

  return {
    ...warningState,
    showWarning,
    hideWarning,
    updateTimeRemaining,
  };
}
