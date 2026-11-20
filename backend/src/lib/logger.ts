import { pino, type Logger } from 'pino';
import type { AppConfig } from '../config.js';

export type { Logger };

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'isDev'>): Logger {
  return pino({
    level: config.logLevel,
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', '*.apiKey', '*.secret', '*.pin'],
      censor: '[redacted]',
    },
    ...(config.isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}
