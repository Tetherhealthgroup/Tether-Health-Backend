import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions as PinoOptions,
} from 'pino';

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
  // What was measured, and what it was called. A metric key such as a blood
  // glucose or a peak-flow reading names a condition, so it is health data
  // before any value is attached to it.
  '*.metricKey',
  '*.metric_key',
  '*.measureId',
  '*.measure_id',
  '*.value_num',
  '*.value_text',
  '*.dosage',
  '*.conditionKind',
];

/**
 * Database fields that carry row contents.
 *
 * `pg` attaches `detail` ("Failing row contains (…)", "Key (email)=(…) already
 * exists"), `where` and `hint` to the errors it throws, and pino's default `err`
 * serializer copies every own property of an error into the line. A check
 * violation on a vital reading would therefore log the reading, its metric key
 * and the person's note. Stripped here for every service, so no handler has to
 * remember it.
 */
const ROW_BEARING_ERROR_FIELDS = [
  'detail',
  'where',
  'hint',
  'internalQuery',
  'internalPosition',
  'parameters',
] as const;

/**
 * pino's standard error serializer, minus anything that can hold a row.
 *
 * Exported so a test can assert on the serializer directly rather than through
 * a log line.
 */
export function serializeError(error: unknown): unknown {
  const serialised = stdSerializers.err(error as Error) as unknown as Record<string, unknown>;
  for (const field of ROW_BEARING_ERROR_FIELDS) {
    delete serialised[field];
  }
  return serialised;
}

export interface LoggerOptions {
  readonly serviceName: string;
  readonly level: string;
  readonly environment: string;
  /** Pretty-print. Never in production — the collector wants JSON. */
  readonly pretty?: boolean;
  /**
   * Where lines go. Left unset in every service, which writes to stdout; a test
   * passes a stream so it can read back exactly what would have been shipped.
   */
  readonly destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  const config: PinoOptions = {
    level: options.level,
    base: {
      service: options.serviceName,
      env: options.environment,
    },
    redact: { paths: REDACTED, censor: '[REDACTED]' },
    serializers: { err: serializeError },
    // Milliseconds since epoch rather than pino's default, so log time and
    // database `timestamptz` compare without anybody converting.
    timestamp: () => `,"time":${Date.now()}`,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(options.pretty && !options.destination
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l' },
          },
        }
      : {}),
  };

  return options.destination ? pino(config, options.destination) : pino(config);
}

export type { Logger };
