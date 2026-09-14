/**
 * The routing table, and the two decisions made from it.
 *
 * Everything in this file is a pure function over strings. That is deliberate:
 * the gateway's only real logic is "which service, what path, and may this
 * caller through without a token", and all three are the kind of thing that is
 * wrong in a way no integration test notices — a prefix that also swallows
 * `/api/v1/careful`, an allowlist entry that accidentally exempts writes. Kept
 * pure, they are testable without a socket, and `test/routes.test.ts` tests
 * exactly them.
 */

/** Which environment variable carries a service's base URL. */
export type ServiceUrlKey =
  | 'AUTH_SERVICE_URL'
  | 'CATALOGUE_SERVICE_URL'
  | 'ENROLMENT_SERVICE_URL'
  | 'RECORDS_SERVICE_URL'
  | 'CARE_TEAM_SERVICE_URL'
  | 'NOTIFICATION_SERVICE_URL'
  | 'WEBSITE_SERVICE_URL'
  | 'CHRONIC_SERVICE_URL'
  | 'REALTIME_SERVICE_URL';

export interface RouteEntry {
  /** The public prefix, without a trailing slash. */
  readonly prefix: string;
  /** For logs and problem details. Never a hostname — that is internal. */
  readonly service: string;
  readonly urlKey: ServiceUrlKey;
}

/**
 * Public prefix → internal service.
 *
 * The prefixes are the API's contract with three front-ends that are already
 * written, so they are listed once, here, rather than spelled out at each
 * `app.use`. `/api/v1/…` is versioned because the Flutter app ships in an App
 * Store release and cannot be redeployed alongside the backend — v1 has to keep
 * answering for as long as an old build is installed on somebody's phone.
 */
export const ROUTES: readonly RouteEntry[] = [
  { prefix: '/api/v1/auth', service: 'auth-service', urlKey: 'AUTH_SERVICE_URL' },
  { prefix: '/api/v1/catalogue', service: 'catalogue-service', urlKey: 'CATALOGUE_SERVICE_URL' },
  { prefix: '/api/v1/enrolments', service: 'enrolment-service', urlKey: 'ENROLMENT_SERVICE_URL' },
  { prefix: '/api/v1/records', service: 'records-service', urlKey: 'RECORDS_SERVICE_URL' },
  { prefix: '/api/v1/care', service: 'care-team-service', urlKey: 'CARE_TEAM_SERVICE_URL' },
  { prefix: '/api/v1/notifications', service: 'notification-service', urlKey: 'NOTIFICATION_SERVICE_URL' },
  { prefix: '/api/v1/waitlist', service: 'website-service', urlKey: 'WEBSITE_SERVICE_URL' },
  { prefix: '/api/v1/chronic', service: 'chronic-service', urlKey: 'CHRONIC_SERVICE_URL' },
  { prefix: '/api/v1/stream', service: 'realtime-service', urlKey: 'REALTIME_SERVICE_URL' },
];

/**
 * True when `pathname` is inside `prefix`, on a path-segment boundary.
 *
 * The boundary check is the whole point. A naive `startsWith('/api/v1/care')`
 * also matches `/api/v1/careful` and `/api/v1/care-team-admin`, which would
 * hand a path the care-team service has never heard of to the care-team
 * service — and, worse, would have applied the care-team prefix's auth rules to
 * it on the way. Only `=== prefix`, `prefix + '/'` and `prefix + '?'` match.
 */
export function matchesPrefix(prefix: string, pathname: string): boolean {
  if (!pathname.startsWith(prefix)) return false;
  const next = pathname.charAt(prefix.length);
  return next === '' || next === '/' || next === '?';
}

/**
 * Removes the `/api/v1/<service>` prefix, preserving the query string.
 *
 * Downstream services are mounted at their own root: the auth service serves
 * `POST /sessions`, not `POST /api/v1/auth/sessions`. It does not know it sits
 * behind a gateway, and it should not — that is what makes it runnable on its
 * own in a test, and what keeps the public URL shape a gateway decision rather
 * than something eight services have to agree on.
 *
 * `/api/v1/waitlist` with nothing after it becomes `/`, not the empty string:
 * an HTTP request line needs a path.
 */
export function stripServicePrefix(prefix: string, url: string): string {
  if (!matchesPrefix(prefix, url)) return url;
  const rest = url.slice(prefix.length);
  if (rest === '') return '/';
  return rest.startsWith('?') ? `/${rest}` : rest;
}

/** The route serving `pathname`, or null. */
export function routeFor(pathname: string): RouteEntry | null {
  return ROUTES.find((route) => matchesPrefix(route.prefix, pathname)) ?? null;
}

/**
 * The public allowlist — every path that may be reached without a Tether token.
 *
 * Allowlist, not denylist. A denylist gets a hole the day somebody adds a
 * route and forgets to list it, and the hole is silent: the endpoint works, so
 * nobody notices it works for anyone. Here the failure mode of forgetting is a
 * 401 on a public endpoint, which somebody reports within the hour.
 *
 * The entries and why each one is here:
 *
 * - `/api/v1/auth/*` — you cannot present a Tether token to the endpoint whose
 *   job is to issue you one. The auth service does its own verification of the
 *   *Supabase* token in the body; it is not unauthenticated, it is
 *   authenticated against a different issuer.
 * - `/api/v1/catalogue/*`, safe methods only — the design bundle is non-PHI and
 *   the website reads it anonymously. Writes to the catalogue are an editorial
 *   action and stay behind a token.
 * - `/api/v1/waitlist` — the enquiry form on a static marketing site. There is
 *   no account yet, by definition.
 * - `/healthz`, `/readyz` — the orchestrator has no credentials.
 * - Any `OPTIONS` — a CORS preflight is sent by the browser without the
 *   `Authorization` header it is asking permission to send. 401-ing a preflight
 *   makes every authenticated cross-origin call fail with a CORS error that
 *   names nothing useful.
 *
 * Note what is *not* here: nothing grants a caller anything. Passing this check
 * only means the gateway does not stop the request; the downstream service
 * still verifies for itself.
 */
export function isPublic(method: string, pathname: string): boolean {
  if (method === 'OPTIONS') return true;
  if (pathname === '/healthz' || pathname === '/readyz') return true;
  if (matchesPrefix('/api/v1/auth', pathname)) return true;
  if (matchesPrefix('/api/v1/waitlist', pathname)) return true;
  if (matchesPrefix('/api/v1/catalogue', pathname)) {
    return method === 'GET' || method === 'HEAD';
  }
  return false;
}
