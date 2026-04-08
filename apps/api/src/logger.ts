/**
 * Structured logger for the API.
 * Production: JSON to stdout (consumed by Railway log aggregator).
 * Dev (NODE_ENV !== production): pino-pretty for human-readable output.
 */

import { pino } from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  name: 'agentscope-api',
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  }),
});

export type Logger = typeof logger;
