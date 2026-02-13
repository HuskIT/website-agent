import type { PreviewConsoleMessage } from './console-interceptor';
import type { ActionAlert } from '~/types/actions';

/**
 * Error queue manager for batching multiple console errors
 *
 * This class accumulates errors over a time window and flushes them
 * as a single batched alert. This allows the LLM to fix multiple
 * errors at once rather than one-by-one.
 */
export class ErrorQueueManager {
  private _errorQueue: PreviewConsoleMessage[] = [];
  private _batchTimer: ReturnType<typeof setTimeout> | null = null;
  private _onFlush: (alert: ActionAlert) => void;
  private _batchWindowMs: number;

  constructor(onFlush: (alert: ActionAlert) => void, batchWindowMs = 800) {
    this._onFlush = onFlush;
    this._batchWindowMs = batchWindowMs;
  }

  /**
   * Add an error to the queue. Starts/resets the batch timer.
   */
  addError(error: PreviewConsoleMessage): void {
    // Clear existing timer
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
    }

    // Add to queue
    this._errorQueue.push(error);

    // Start new timer for batch window
    this._batchTimer = setTimeout(() => {
      this._flushBatch();
    }, this._batchWindowMs);
  }

  /**
   * Force flush the current batch immediately
   */
  flush(): void {
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }

    this._flushBatch();
  }

  /**
   * Clear all queued errors without flushing
   */
  clear(): void {
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }

    this._errorQueue = [];
  }

  /**
   * Get current queue length
   */
  get queueLength(): number {
    return this._errorQueue.length;
  }

  private _flushBatch(): void {
    if (this._errorQueue.length === 0) {
      return;
    }

    // Deduplicate errors by message hash
    const uniqueErrors = this._deduplicateErrors();

    // Format batched alert
    const alert = this._formatBatchedAlert(uniqueErrors);

    // Trigger alert callback
    this._onFlush(alert);

    // Clear queue
    this._errorQueue = [];
    this._batchTimer = null;
  }

  private _deduplicateErrors(): PreviewConsoleMessage[] {
    const seen = new Set<string>();
    return this._errorQueue.filter((error) => {
      const hash = this._hashError(error);

      if (seen.has(hash)) {
        return false;
      }

      seen.add(hash);

      return true;
    });
  }

  private _hashError(error: PreviewConsoleMessage): string {
    // Simple hash: first 100 chars of message
    return error.message.substring(0, 100);
  }

  private _formatBatchedAlert(errors: PreviewConsoleMessage[]): ActionAlert {
    const count = errors.length;
    const title = count === 1 ? 'Runtime Error in Preview' : `${count} Runtime Errors in Preview`;
    const description =
      count === 1
        ? 'An error occurred in the generated website. Send to HuskIT AI to fix?'
        : `${count} errors occurred in the generated website. Send all to HuskIT AI to fix at once?`;

    // Format errors as numbered list for LLM
    const content = errors.map((err, i) => `${i + 1}. ${err.message}`).join('\n\n');

    return {
      type: 'error',
      title,
      description,
      content,
      source: 'preview',
    };
  }
}
