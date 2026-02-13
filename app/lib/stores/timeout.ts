/**
 * Timeout State Store
 * Feature: 001-sandbox-providers
 *
 * Centralized state for sandbox timeout events and dialogs.
 */

import { atom } from 'nanostores';

export interface TimeoutEvent {
  timestamp: number;
  reason: 'expired' | 'manual';
}

/**
 * Atom that triggers when a timeout occurs.
 * Set to null when the dialog is dismissed.
 */
export const timeoutEvent = atom<TimeoutEvent | null>(null);

/**
 * Trigger a timeout event (called by TimeoutManager)
 */
export function triggerTimeoutEvent(reason: 'expired' | 'manual' = 'expired'): void {
  timeoutEvent.set({
    timestamp: Date.now(),
    reason,
  });
}

/**
 * Clear timeout event (called when dialog is dismissed)
 */
export function clearTimeoutEvent(): void {
  timeoutEvent.set(null);
}
