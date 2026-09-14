import { z } from 'zod';

/**
 * Environment, validated once at boot.
 *
 * Fail-fast, by design: a service that starts with half its configuration
 * missing does not fail at boot, it fails at 3am on the one code path that
 * needed the variable. The model repo got this right and it is worth keeping —
 * what it did not do was describe the shape anywhere, so each of its ten
 * services checked a slightly different subset by hand.
 *
 * Every service calls `loadConfig` with its own extra schema. The base below is
 * what all of them need.
 */

const nonEmpty = z.string().min(1);

/** Comma-separated list, trimmed, empties dropped. */
const list = z
  .string()
  .transform((value) => value.split(',').map((s) => s.trim()).filter(Boolean));

export const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: nonEmpty,
  PORT: z.coerce.number().int().positive(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  /** Where problem `type` URIs resolve. */
  PUBLIC_API_URL: z.string().url().default('http://localhost:8000'),

  /**
   * Exact origins allowed to call the API.
   *
   * No default, and an empty value denies everything. That is deliberate: a
   * CORS list that falls back to `*` when unset is a CORS list that is `*` in
   * every environment somebody forgot to configure.
   */
  ALLOWED_ORIGINS: list.default(''),

  /** Verified against the JWT's `iss`. */
  JWT_ISSUER: z.string().url(),

  /**
   * Verified against the JWT's `aud`.
   *
   * Asserted rather than ignored. A token minted for a different audience in
   * the same issuer's realm is a valid signature and the wrong caller, and
   * checking only the signature cannot tell the two apart.
   */
  JWT_AUDIENCE: nonEmpty,

  /** Where the issuer publishes its signing keys. */
  JWT_JWKS_URL: z.string().url(),

  /**
   * Exactly one algorithm.
   *
   * The model repo passed `['ES256','HS256']` to every verification, which
   * offers the same configured string as both an HMAC secret and an ECDSA
   * public key — the classic algorithm-confusion forgery. One value, always.
   */
  JWT_ALGORITHM: z.enum(['RS256', 'ES256']).default('RS256'),

  /** Postgres DSN. Per service, with that service's own role. */
  DATABASE_URL: nonEmpty,

  /** Statement timeout, milliseconds. A slow query is a failed query here. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  /** Request body ceiling. One number, shared, so it cannot drift per service. */
  BODY_LIMIT: z.string().default('512kb'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
});

export type BaseConfig = z.infer<typeof baseSchema>;

/**
 * Parses `source` against the base schema merged with `extra`.
 *
 * Throws with every problem listed at once rather than the first — finding out
 * about five missing variables one redeploy at a time is its own kind of
 * outage.
 */
export function loadConfig<T extends z.ZodRawShape>(
  extra?: z.ZodObject<T>,
  source: NodeJS.ProcessEnv = process.env,
): BaseConfig & z.infer<z.ZodObject<T>> {
  const schema = extra ? baseSchema.merge(extra) : baseSchema;
  const result = schema.safeParse(source);

  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(
      `Configuration is not usable. ${lines.length} problem(s):\n${lines.join('\n')}`,
    );
  }

  return result.data as BaseConfig & z.infer<z.ZodObject<T>>;
}

export const isProduction = (config: BaseConfig): boolean =>
  config.NODE_ENV === 'production';
