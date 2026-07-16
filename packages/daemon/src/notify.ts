import type { Logger } from '@owl/core';
import notifier from 'node-notifier';

export interface NotifyOptions {
  title: string;
  body: string;
}

/**
 * True when running under a test runner (`node --test` or vitest). A reminder
 * notification is a real OS side effect: firing it during tests spawns a
 * `terminal-notifier` helper process and leaves a banner stuck in macOS
 * Notification Center, which then re-presents itself indefinitely. Suppress
 * delivery under any test runtime; production daemons are unaffected.
 */
function isTestRuntime(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST != null ||
    process.execArgv.some((arg) => arg === '--test' || arg.startsWith('--test'))
  );
}

export function sendNotification(options: NotifyOptions, logger: Logger): void {
  const { title, body } = options;

  if (isTestRuntime()) {
    logger.info({ title, body }, 'Notification suppressed (test runtime)');
    return;
  }

  notifier.notify(
    {
      title,
      message: body,
      sound: true,
    },
    (err) => {
      if (err) {
        logger.error({ err }, 'Failed to send notification');
      }
    },
  );

  logger.info({ title, body }, 'Notification sent');
}
