import type { Logger } from '@owl/core';
import notifier from 'node-notifier';

export interface NotifyOptions {
  title: string;
  body: string;
}

export function sendNotification(options: NotifyOptions, logger: Logger): void {
  const { title, body } = options;

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
