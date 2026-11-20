import { Logger } from 'winston';
import { KnownError } from '../error';
import { getErrorType } from '../util/logger';
import { clearActiveJob, markActiveJobRecording } from './recovery';

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export class JobStore {
  private isRunning: boolean = false;
  private shutdownRequested: boolean = false;
  // Set by the bot once it is recording; ends the recording the same way the
  // in-meeting detectors do, so it still uploads. Cleared when the job ends.
  private stopHandler: (() => Promise<void>) | null = null;
  // Set by the bot once its browser exists; closes it so /stop can abandon a
  // join (lobby, bot-blocked page) instead of waiting out JOIN_WAIT_TIME.
  private cancelHandler: (() => Promise<void>) | null = null;
  // Ends the current job at once (see addJob); null when idle.
  private abortJob: (() => void) | null = null;

  async addJob<T>(
    task: () => Promise<T>, 
    logger: Logger,
    retryCount: number = 0,
    onPermanentFailure?: (error: unknown) => Promise<void> | void,
    onCompleted?: () => Promise<void> | void
  ): Promise<{ accepted: boolean }> {
    if (this.isRunning || this.shutdownRequested) {
      return { accepted: false };
    }

    this.isRunning = true;

    // The bots' lobby loops swallow errors until their own timeout, so closing
    // the browser alone would not end a cancelled join promptly: race the task
    // against an abort instead. The abandoned task dies out against its closed
    // browser, and job.cancelled stops it from retrying into a new one.
    const job = { cancelled: false };
    const aborted = new Promise<never>((_, reject) => {
      this.abortJob = () => {
        job.cancelled = true;
        reject(new Error('Join cancelled by /stop'));
      };
    });
    const run = this.executeTaskWithRetry(task, logger, retryCount, job);
    run.catch(() => {}); // settled through the race below

    // Execute the task asynchronously without waiting for completion
    Promise.race([run, aborted]).then(async () => {
      logger.info('LogBasedMetric Bot has finished recording meeting successfully.');
      if (onCompleted) {
        try {
          await onCompleted();
        } catch (completionCallbackError) {
          logger.warn('Meeting completion callback failed', completionCallbackError as any);
        }
      }
    }).catch(async (error) => {
      const errorType = getErrorType(error);
      if (error instanceof KnownError) {
        logger.error('KnownError JobStore is permanently exiting:', { error });
      } else {
        logger.error('Error executing task after multiple retries:', { error });
      }
      logger.error(`LogBasedMetric Bot has permanently failed. [errorType: ${errorType}]`);
      if (onPermanentFailure) {
        try {
          await onPermanentFailure(error);
        } catch (failureNotificationError) {
          logger.warn('Meeting failure notification failed', failureNotificationError as any);
        }
      }
    }).finally(() => {
      this.isRunning = false;
      this.stopHandler = null;
      this.cancelHandler = null;
      this.abortJob = null;
      // Finished, failed or stopped: nothing to rejoin after a restart.
      clearActiveJob();
    });

    logger.info('LogBasedMetric Bot job has been queued and started recording meeting.');
    return { accepted: true };
  }

  private async executeTaskWithRetry<T>(
    task: () => Promise<T>,
    logger: Logger,
    retryCount: number,
    job: { cancelled: boolean }
  ): Promise<void> {
    try {
      await task();
    } catch (error) {
      if (job.cancelled) throw error;

      if (error instanceof KnownError && !error.retryable) {
        logger.error('KnownError is not retryable:', error.name, error.message);
        throw error;
      }

      if (error instanceof KnownError && error.retryable && (retryCount + 1) >= error.maxRetries) {
        logger.error(`KnownError: ${error.maxRetries} tries consumed:`, error.name, error.message);
        throw error;
      }

      retryCount += 1;
      await sleep(retryCount * 30000);
      if (job.cancelled) throw error;
      if (retryCount < 3) {
        if (retryCount) {
          logger.warn(`Retry count: ${retryCount}`);
        }
        await this.executeTaskWithRetry(task, logger, retryCount, job);
      } else {
        throw error;
      }
    }
  }

  isBusy(): boolean {
    return this.isRunning;
  }

  getState(): 'idle' | 'joining' | 'recording' {
    if (!this.isRunning) return 'idle';
    return this.stopHandler ? 'recording' : 'joining';
  }

  /** Called by the bot when recording starts. */
  setStopHandler(handler: () => Promise<void>): void {
    this.stopHandler = handler;
    markActiveJobRecording();
  }

  /** Called by the bot once its browser exists. */
  setCancelHandler(handler: () => Promise<void>): void {
    this.cancelHandler = handler;
  }

  /**
   * Recording: stop now and upload what was recorded. Joining (or waiting to
   * retry): give up on this meeting at once.
   * @returns false when idle
   */
  async requestStop(): Promise<boolean> {
    if (!this.isRunning) return false;
    if (this.stopHandler) {
      await this.stopHandler();
      return true;
    }
    const cancel = this.cancelHandler;
    this.abortJob?.();
    await cancel?.().catch(() => {});
    return true;
  }

  /**
   * Check if shutdown has been requested
   */
  isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }

  /**
   * Request graceful shutdown - prevents new jobs from being accepted
   */
  requestShutdown(): void {
    this.shutdownRequested = true;
  }

  /**
   * Wait for ongoing tasks to complete
   * @returns Promise that resolves when all tasks are complete
   */
  async waitForCompletion(): Promise<void> {
    if (!this.isRunning) {
      return; // No tasks running, can shutdown immediately
    }

    console.log('Waiting for ongoing tasks to complete...');
    
    return new Promise<void>((resolve) => {
      const checkCompletion = () => {
        if (!this.isRunning) {
          console.log('All tasks completed successfully');
          resolve();
        } else {
          setTimeout(checkCompletion, 1000); // Check every 1 second
        }
      };
      checkCompletion();
    });
  }
} 
