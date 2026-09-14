import { z } from 'zod';

/**
 * The gateway's own environment, on top of `@tether/core`'s base schema.
 *
 * Every downstream address is a variable rather than a constant, because the
 * same image has to run under Docker Compose (`http://auth-service:8001`), in
 * a test harness (`http://127.0.0.1:…`) and eventually behind whatever service
 * discovery production uses. Hard-coding the Compose hostnames is how a gateway
 * becomes undeployable anywhere else.
 */

const serviceUrl = z.string().url();

export const gatewaySchema = z.object({
  AUTH_SERVICE_URL: serviceUrl,
  CATALOGUE_SERVICE_URL: serviceUrl,
  ENROLMENT_SERVICE_URL: serviceUrl,
  RECORDS_SERVICE_URL: serviceUrl,
  CARE_TEAM_SERVICE_URL: serviceUrl,
  NOTIFICATION_SERVICE_URL: serviceUrl,
  WEBSITE_SERVICE_URL: serviceUrl,
  CHRONIC_SERVICE_URL: serviceUrl,
  REALTIME_SERVICE_URL: serviceUrl,

  /**
   * How long the gateway waits for a downstream service before giving up.
   *
   * Shorter than any sane client timeout on purpose. If the gateway waits
   * longer than the phone does, the phone hangs up first, the gateway keeps the
   * upstream socket open, and under load the pool fills with requests nobody is
   * listening to any more.
   */
  PROXY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  /**
   * Overrides the base schema, which requires a DSN of every service.
   *
   * The gateway opens no pool: it holds no data and answers no query, and
   * giving it a database connection would be giving it a capability it has no
   * use for and could only misuse. `baseSchema.merge()` lets the later shape
   * win, so this key becomes optional here and nowhere else — which is
   * preferable to inventing a placeholder DSN in the deployment config, where
   * it would read like an oversight rather than a decision.
   */
  DATABASE_URL: z.string().optional(),
});

export type GatewayConfig = z.infer<typeof gatewaySchema>;
