import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTES,
  isPublic,
  matchesPrefix,
  routeFor,
  stripServicePrefix,
} from '../src/routes.ts';
import { statusForProxyError } from '../src/proxy.ts';

/**
 * What is tested here, and what is not.
 *
 * Not tested: that Express routes, that `http-proxy-middleware` proxies, that
 * helmet sets headers. Those are other people's test suites and asserting them
 * again only guarantees this suite breaks when they upgrade.
 *
 * Tested: the two decisions the gateway makes that nobody else can make for it
 * — which service a path belongs to and what the path becomes on the way there,
 * and whether a request may pass without a token. Both are string logic, both
 * fail silently when wrong, and both are security-relevant in one direction.
 */

test('prefix matching respects path-segment boundaries', () => {
  assert.equal(matchesPrefix('/api/v1/care', '/api/v1/care'), true);
  assert.equal(matchesPrefix('/api/v1/care', '/api/v1/care/'), true);
  assert.equal(matchesPrefix('/api/v1/care', '/api/v1/care/patients'), true);
  assert.equal(matchesPrefix('/api/v1/care', '/api/v1/care?page=2'), true);

  // The reason the boundary check exists: a plain `startsWith` sends all three
  // of these to the care-team service.
  assert.equal(matchesPrefix('/api/v1/care', '/api/v1/careful'), false);
  assert.equal(matchesPrefix('/api/v1/care', '/api/v1/care-team-admin'), false);
  assert.equal(matchesPrefix('/api/v1/care', '/api/v1/carer/1'), false);

  assert.equal(matchesPrefix('/api/v1/care', '/api/v1/records'), false);
  assert.equal(matchesPrefix('/api/v1/care', '/care'), false);
});

test('the service prefix is stripped and the rest of the path survives', () => {
  assert.equal(stripServicePrefix('/api/v1/auth', '/api/v1/auth/sessions'), '/sessions');
  assert.equal(
    stripServicePrefix('/api/v1/auth', '/api/v1/auth/sessions/refresh'),
    '/sessions/refresh',
  );
  assert.equal(
    stripServicePrefix('/api/v1/auth', '/api/v1/auth/.well-known/jwks.json'),
    '/.well-known/jwks.json',
  );
});

test('the query string is preserved across stripping', () => {
  assert.equal(
    stripServicePrefix('/api/v1/records', '/api/v1/records/answers?enrolment=abc&limit=50'),
    '/answers?enrolment=abc&limit=50',
  );
  // Prefix with nothing but a query after it still needs a path on the wire.
  assert.equal(stripServicePrefix('/api/v1/waitlist', '/api/v1/waitlist?source=astro'), '/?source=astro');
});

test('a bare prefix becomes the downstream root, not the empty string', () => {
  // `POST /api/v1/waitlist` is the website form's only endpoint; it must arrive
  // at website-service as `POST /`, and `POST ` is not a request line.
  assert.equal(stripServicePrefix('/api/v1/waitlist', '/api/v1/waitlist'), '/');
  assert.equal(stripServicePrefix('/api/v1/waitlist', '/api/v1/waitlist/'), '/');
});

void test('enrolment-service receives its resource name (BE-049)', () => {
  // enrolment-service serves `/enrolments...`, so the public prefix is rewritten
  // to that name rather than removed. Waitlist and stream are deliberately
  // unchanged (they arrive at `/`) until BE-001 lands; see composition.test.ts.
  assert.equal(stripServicePrefix('/api/v1/enrolments', '/api/v1/enrolments'), '/enrolments');
  assert.equal(stripServicePrefix('/api/v1/enrolments', '/api/v1/enrolments/'), '/enrolments/');
  assert.equal(
    stripServicePrefix('/api/v1/enrolments', '/api/v1/enrolments/tobacco/sharing?x=1'),
    '/enrolments/tobacco/sharing?x=1',
  );
  assert.equal(stripServicePrefix('/api/v1/enrolments', '/api/v1/enrolments?limit=5'), '/enrolments?limit=5');
});

test('a path outside the prefix is returned untouched', () => {
  assert.equal(stripServicePrefix('/api/v1/care', '/api/v1/careful/x'), '/api/v1/careful/x');
  assert.equal(stripServicePrefix('/api/v1/care', '/healthz'), '/healthz');
});

test('every documented prefix resolves to its own service', () => {
  const expected: ReadonlyArray<readonly [string, string]> = [
    ['/api/v1/auth/sessions', 'auth-service'],
    ['/api/v1/catalogue/areas', 'catalogue-service'],
    ['/api/v1/enrolments/123', 'enrolment-service'],
    ['/api/v1/records/answers', 'records-service'],
    ['/api/v1/care/patients', 'care-team-service'],
    ['/api/v1/notifications/devices', 'notification-service'],
    ['/api/v1/waitlist', 'website-service'],
    ['/api/v1/chronic/vitals', 'chronic-service'],
  ];

  for (const [path, service] of expected) {
    assert.equal(routeFor(path)?.service, service, path);
  }

  // No prefix is a prefix of another in a way that makes the table
  // order-dependent, and no service is reachable at two prefixes.
  assert.equal(new Set(ROUTES.map((r) => r.prefix)).size, ROUTES.length);
  assert.equal(new Set(ROUTES.map((r) => r.service)).size, ROUTES.length);
  assert.equal(new Set(ROUTES.map((r) => r.urlKey)).size, ROUTES.length);
});

test('nothing outside the table is routed anywhere', () => {
  assert.equal(routeFor('/api/v1/admin'), null);
  assert.equal(routeFor('/api/v2/records'), null);
  assert.equal(routeFor('/records'), null);
  assert.equal(routeFor('/'), null);
});

test('the public allowlist lets through exactly what it should', () => {
  // Issuing a token cannot require a token.
  assert.equal(isPublic('POST', '/api/v1/auth/sessions'), true);
  assert.equal(isPublic('POST', '/api/v1/auth/sessions/refresh'), true);
  assert.equal(isPublic('GET', '/api/v1/auth/.well-known/jwks.json'), true);

  // Non-PHI, read anonymously by the marketing site and by a cold app start.
  assert.equal(isPublic('GET', '/api/v1/catalogue/areas'), true);
  assert.equal(isPublic('HEAD', '/api/v1/catalogue/areas'), true);

  // The website form: there is no account yet, by definition.
  assert.equal(isPublic('POST', '/api/v1/waitlist'), true);

  // The orchestrator has no credentials.
  assert.equal(isPublic('GET', '/healthz'), true);
  assert.equal(isPublic('GET', '/readyz'), true);

  // A preflight is sent without the Authorization header it is asking about.
  assert.equal(isPublic('OPTIONS', '/api/v1/records/answers'), true);
});

test('the public allowlist stops at reads of the catalogue', () => {
  // Editing the design bundle is an editorial action, not a public one.
  assert.equal(isPublic('POST', '/api/v1/catalogue/areas'), false);
  assert.equal(isPublic('PUT', '/api/v1/catalogue/areas/smoking'), false);
  assert.equal(isPublic('PATCH', '/api/v1/catalogue/areas/smoking'), false);
  assert.equal(isPublic('DELETE', '/api/v1/catalogue/areas/smoking'), false);
});

test('every PHI-bearing prefix requires a token, on every method', () => {
  const guarded = [
    '/api/v1/enrolments',
    '/api/v1/enrolments/abc/consent',
    '/api/v1/records',
    '/api/v1/records/answers',
    '/api/v1/care',
    '/api/v1/care/patients/abc',
    '/api/v1/notifications',
    '/api/v1/chronic',
    '/api/v1/chronic/vitals',
  ];
  for (const path of guarded) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(isPublic(method, path), false, `${method} ${path}`);
    }
  }
});

test('an allowlist entry does not leak onto a neighbouring prefix', () => {
  // The same boundary bug as routing, but this one fails open: `/api/v1/authz`
  // exempted because it starts with `/api/v1/auth` would be an unauthenticated
  // door into whatever was mounted there next.
  assert.equal(isPublic('GET', '/api/v1/authz/policies'), false);
  assert.equal(isPublic('GET', '/api/v1/catalogue-admin/areas'), false);
  assert.equal(isPublic('POST', '/api/v1/waitlisted'), false);
  assert.equal(isPublic('GET', '/healthzz'), false);
});

test('unreachable and unresponsive upstreams are told apart', () => {
  // 502: nothing is listening. A deploy, a DNS entry, a container that died.
  assert.equal(statusForProxyError('ECONNREFUSED'), 502);
  assert.equal(statusForProxyError('ENOTFOUND'), 502);
  assert.equal(statusForProxyError('EHOSTUNREACH'), 502);

  // 504: something is listening and did not answer. A slow query.
  assert.equal(statusForProxyError('ETIMEDOUT'), 504);
  assert.equal(statusForProxyError('ECONNRESET'), 504);

  // Unknown failures are upstream failures, not 500s — the gateway itself is
  // fine, which is what a 500 here would wrongly claim.
  assert.equal(statusForProxyError(undefined), 502);
  assert.equal(statusForProxyError('SOMETHING_NEW'), 502);
});
