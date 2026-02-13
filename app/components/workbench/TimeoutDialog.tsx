/**
 * Timeout Dialog Component
 * Feature: 001-sandbox-providers
 *
 * Displays an active confirmation dialog when the sandbox session expires,
 * requiring the user to explicitly choose to restart or end the session.
 */

import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { classNames } from '~/utils/classNames';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('TimeoutDialog');

interface TimeoutDialogProps {
  /** Whether the dialog is visible */
  isVisible: boolean;

  /** Callback when user chooses to restart */
  onRestart: () => void;

  /** Callback when user dismisses (ends session) */
  onDismiss: () => void;
}

/**
 * TimeoutDialog displays a modal dialog when the sandbox session expires,
 * forcing the user to make an explicit choice: restart or end the session.
 */
export function TimeoutDialog({ isVisible, onRestart, onDismiss }: TimeoutDialogProps) {
  const [isRestarting, setIsRestarting] = useState(false);

  const handleRestart = useCallback(async () => {
    setIsRestarting(true);
    logger.info('User chose to restart session');

    try {
      await onRestart();
    } catch (error) {
      logger.error('Error restarting session', { error });
    } finally {
      setIsRestarting(false);
    }
  }, [onRestart]);

  const handleDismiss = useCallback(() => {
    logger.info('User chose to end session');
    onDismiss();
  }, [onDismiss]);

  return (
    <AnimatePresence>
      {isVisible && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm"
            onClick={handleDismiss}
          />

          {/* Dialog */}
          <div className="fixed inset-0 z-[101] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className={classNames(
                'relative max-w-md w-full',
                'bg-white dark:bg-bolt-elements-background-depth-2',
                'rounded-2xl shadow-2xl border border-bolt-elements-borderColor',
                'overflow-hidden',
              )}
              role="alertdialog"
              aria-labelledby="timeout-dialog-title"
              aria-describedby="timeout-dialog-description"
            >
              {/* Header with icon */}
              <div className="p-6 pb-4">
                <div className="flex items-start gap-4">
                  {/* Warning Icon */}
                  <div className="flex-shrink-0">
                    <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center">
                      <svg
                        className="w-6 h-6 text-amber-600 dark:text-amber-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                        />
                      </svg>
                    </div>
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <h2 id="timeout-dialog-title" className="text-xl font-semibold text-bolt-elements-textPrimary mb-2">
                      Session Expired
                    </h2>
                    <p
                      id="timeout-dialog-description"
                      className="text-sm text-bolt-elements-textSecondary leading-relaxed"
                    >
                      Your sandbox session has reached the maximum lifetime (10 minutes). Your work has been
                      automatically saved.
                    </p>
                    <p className="text-sm text-bolt-elements-textSecondary leading-relaxed mt-2">
                      Would you like to restart the session to continue working, or end the session?
                    </p>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="px-6 pb-6 pt-2">
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleRestart}
                    disabled={isRestarting}
                    className={classNames(
                      'flex-1 px-4 py-2.5 rounded-lg font-medium text-sm transition-colors',
                      'bg-bolt-elements-button-primary-background hover:bg-bolt-elements-button-primary-backgroundHover',
                      'text-bolt-elements-button-primary-text',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      'focus:outline-none focus:ring-2 focus:ring-bolt-elements-button-primary-background focus:ring-offset-2',
                    )}
                  >
                    {isRestarting ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
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
                        Restarting...
                      </span>
                    ) : (
                      'Restart Session'
                    )}
                  </button>

                  <button
                    onClick={handleDismiss}
                    disabled={isRestarting}
                    className={classNames(
                      'flex-1 px-4 py-2.5 rounded-lg font-medium text-sm transition-colors',
                      'bg-bolt-elements-button-secondary-background hover:bg-bolt-elements-button-secondary-backgroundHover',
                      'text-bolt-elements-button-secondary-text',
                      'border border-bolt-elements-borderColor',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      'focus:outline-none focus:ring-2 focus:ring-bolt-elements-borderColor focus:ring-offset-2',
                    )}
                  >
                    End Session
                  </button>
                </div>
              </div>

              {/* Info footer */}
              <div className="px-6 py-3 bg-bolt-elements-background-depth-1 border-t border-bolt-elements-borderColor">
                <p className="text-xs text-bolt-elements-textTertiary">
                  💡 Tip: Active sessions are automatically extended based on your activity to minimize interruptions.
                </p>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
