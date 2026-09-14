import { pino, type Logger } from 'pino';

/**
 * One logger, one configuration.
 *
 * Lifted from the model repo, where it was the best-written file — and where it
 * was also copy-pasted identically into ten services, which is why it is a
 * package here.
 *
 * The redaction list is the part that matters. Logs leave the process: they go
 * to a collector, they get indexed, they get read by whoever is on call. In a
 * health product an unredacted request body in a log line is a disclosure, and
 * the cheapest way to never make that mistake is to never have to remember.
 */

/**
 * Paths scrubbed before anything is written.
 *
 * Wider than the model's list in three places that matter here: `*.answers` and
 * `*.text` (a person's own words, from the check-in and reasons screens),
 * `*.note` and `*.severity` (chronic-care's vitals note and Tether's lapse
 * description), and `*.email`/`*.phone` — identifiers that make everything else
 * in the line attributable.
 */
const REDACTED = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.apiKey',
  '*.serviceRoleKey',
  '*.email',
  '*.phone',
  '*.answers',
  '*.text',
  '*.note',
  '*.severity',
  '*.recipient',
];

export interface LoggerOptions {
  readonly serviceName: string;
  readonly level: string;
  readonly environment: string;
  /** Pretty-print. Never in production — the collector wants JSON. */
  readonly pretty?: boolean;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    base: {
      service: options.serviceName,
      env: options.environment,
    },
    redact: { paths: REDACTED, censor: '[REDACTED]' },
    // Milliseconds since epoch rather than pino's default, so log time and
    // database `timestamptz` compare without anybody converting.
    timestamp: () => `,"time":${Date.now()}`,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l' },
          },
        }
      : {}),
  });
}

export type { Logger };
