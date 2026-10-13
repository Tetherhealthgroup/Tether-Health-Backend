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
/**
 * Keys that name or carry what was measured, redacted wherever they sit: at the
 * top level of a log object and one level down. pino's `*` matches exactly one
 * level, so each is listed both ways.
 */
const SENSITIVE_KEYS = [
  'metricKey',
  'metric_key',
  'measureId',
  'measure_id',
  'value_num',
  'value_text',
  'dosage',
  'conditionKind',
];

const REDACTED = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
  // A refusal's `context` names the programme somebody tried to reach, which is
  // a health category. The request id is what ties the line to anything.
  'context.areaId',
  'context.enrolmentId',
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
 * pino's standard error serializer, minus anything that can hold a row, at every
 * depth.
 *
 * pino's serializer copies the top error's own properties and folds a `cause`
 * into `message` and `stack`. It does not look inside an own property that is
 * itself an error or an object (a wrapper that keeps the driver's error as
 * `original`), and it does not serialise `AggregateError.errors` at all. Both
 * are walked here, so a row-bearing field is removed wherever it sits.
 *
 * Exported so a test can assert on the serializer directly rather than through
 * a log line.
 */
export function serializeError(error: unknown): unknown {
  return scrub(error, new WeakSet(), 0);
}

const MAX_DEPTH = 6;

function scrub(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value) || depth > MAX_DEPTH) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, seen, depth + 1));
  }

  const isError = value instanceof Error;
  const base = isError
    ? (stdSerializers.err(value) as unknown as Record<string, unknown>)
    : { ...(value as Record<string, unknown>) };

  for (const field of ROW_BEARING_ERROR_FIELDS) {
    delete base[field];
  }
  if (isError && value instanceof AggregateError) {
    base.errors = value.errors.map((inner) => scrub(inner, seen, depth + 1));
  }
  for (const key of Object.keys(base)) {
    base[key] = scrub(base[key], seen, depth + 1);
  }
  return base;
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
