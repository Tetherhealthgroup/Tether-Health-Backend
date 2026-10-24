import { ServerResponse } from 'node:http';
import type { Request, RequestHandler, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { ProblemError, ProblemType } from '@tether/core';
import type { RouteEntry } from './routes.ts';
import { matchesPrefix, stripServicePrefix } from './routes.ts';

/**
 * One reverse-proxy middleware per downstream service.
 *
 * ## The body-parser trap this file exists to avoid
 *
 * The repo this backend is modelled on mounted `express.json()` globally and
 * then proxied with raw `http-proxy`'s `proxy.web(req, res, {target})`, with no
 * `buffer` option. `http-proxy`'s web-incoming pass ends with
 *
 *     (options.buffer || req).pipe(proxyReq);
 *
 * and by the time that line runs the body parser has already read `req` to
 * completion. Piping an exhausted stream writes nothing and never fires `end`,
 * so `proxyReq` is never terminated: the downstream service sits waiting for a
 * body that has already been consumed, and every proxied POST, PUT and PATCH
 * hangs until something times out. It is a total outage on all writes that
 * looks, in the logs, like a slow downstream.
 *
 * The fix here is structural rather than a workaround. `src/app.ts` mounts the
 * proxies *before* any body parser exists in the stack, so the request stream
 * reaches this middleware untouched and is piped through byte-for-byte. The
 * gateway parses JSON only on the handful of routes it answers itself, and
 * mounts that parser after these. See the comment in `src/app.ts` for why the
 * gateway therefore does not use `createApp` from `@tether/core`.
 *
 * `http-proxy-middleware` is used rather than `http-proxy` directly because it
 * is the layer that gets the stream handling and the Express integration right;
 * the alternative remedy — `fixRequestBody`, which re-serialises `req.body`
 * after a parser has eaten it — is deliberately *not* used, because it can only
 * reconstruct what it could parse. A multipart upload, a `text/plain` payload
 * or any content type the parser skipped would still be lost, and the bug would
 * come back for exactly the requests hardest to test.
 */

export interface ProxyOptions {
  readonly route: RouteEntry;
  readonly target: string;
  readonly timeoutMs: number;
}

/**
 * Headers a client is never allowed to set on the way in.
 *
 * The gateway deliberately does not mint a trusted internal header saying who
 * the caller is — every service re-verifies the token itself, because a service
 * that believed a header would trust anyone who could open a socket to it on
 * the internal network. Since no such header is trusted, none should be
 * forwarded either: stripping them now means a service that starts reading one
 * in six months finds it empty rather than finding it attacker-controlled.
 */
const STRIPPED_REQUEST_HEADERS = [
  'x-tether-account-id',
  'x-tether-roles',
  'x-tether-internal',
  'x-forwarded-user',
] as const;

/**
 * Maps a socket-level failure to the status the client should see.
 *
 * 502 means "the upstream is not there"; 504 means "the upstream is there and
 * did not answer in time". The distinction matters on call: the first is a
 * deploy or DNS problem, the second is a slow query.
 *
 * `ECONNRESET` is filed under 504 with a caveat. `http-proxy` implements its
 * own `proxyTimeout` by calling `proxyReq.abort()`, which surfaces as an
 * `ECONNRESET` indistinguishable from a genuine reset by the peer — so the more
 * common cause behind this gateway wins, and the true error code is logged
 * either way.
 */
export function statusForProxyError(code: string | undefined): number {
  switch (code) {
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EAI_AGAIN':
    case 'EPROTO':
      return 502;
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
    case 'ECONNRESET':
    case 'EPIPE':
      return 504;
    default:
      return 502;
  }
}

export function createServiceProxy(options: ProxyOptions): RequestHandler {
  const { route, target, timeoutMs } = options;

  const proxy = createProxyMiddleware<Request, Response>({
    target,
    changeOrigin: true,

    // The outgoing socket, not the incoming one. A downstream service that has
    // not answered in this long is not going to.
    proxyTimeout: timeoutMs,
    timeout: timeoutMs,

    // Appends to `x-forwarded-for` rather than replacing it, and sets
    // `-port`/`-proto`/`-host` alongside. The downstream services need the real
    // client address for their own rate limiting and for `ops.audit_event.ip` —
    // without it every audit row in the system records the gateway's address.
    xfwd: true,

    // Only this service's prefix. A function filter is used rather than the
    // string form because `http-proxy-middleware`'s string matching is a plain
    // `indexOf(...) === 0`, which does not respect segment boundaries.
    pathFilter: (pathname) => matchesPrefix(route.prefix, pathname),

    // Receives `req.url` — path plus query — before it goes on the wire.
    pathRewrite: (path) => stripServicePrefix(route.prefix, path),

    on: {
      proxyReq: (proxyReq, req) => {
        for (const header of STRIPPED_REQUEST_HEADERS) {
          proxyReq.removeHeader(header);
        }
        // The correlation id `@tether/core`'s middleware generated (or accepted)
        // at the edge. Forwarded so one patient-reported failure is one id
        // across eight services' logs, rather than eight unrelated ids.
        if (req.requestId) proxyReq.setHeader('x-request-id', req.requestId);
      },

      /**
       * Supplying `on.error` also suppresses `http-proxy-middleware`'s default
       * error plugin, which ends the response with a plain-text
       * `Error occurred while trying to proxy: …`. That string is the reason
       * this handler exists: a client that has been told every error in this
       * API is `application/problem+json` should not get an untyped body with a
       * downstream hostname in it the one time the failure is ours.
       */
      error: (error, req, res) => {
        const code = (error as NodeJS.ErrnoException).code;
        const status = statusForProxyError(code);

        req.log?.error(
          { err: error, code, service: route.service, status },
          'upstream request failed',
        );

        // A failed WebSocket upgrade hands back a raw socket, which cannot be
        // given a status line. Nothing to say; close it.
        if (!(res instanceof ServerResponse)) {
          res.destroy();
          return;
        }
        if (res.headersSent) {
          res.end();
          return;
        }

        // `ProblemType` has no `upstream-unavailable` member, and adding one
        // means editing `@tether/core`, which is shared and frozen for this
        // change. `internal-error` is the honest fallback — the client learns
        // the status and the request id, and nothing about our topology. A
        // dedicated type belongs in core the next time it is opened.
        const problem = new ProblemError(
          ProblemType.internal,
          status,
          status === 504
            ? 'The service did not respond in time.'
            : 'The service is not reachable.',
        );

        res
          .writeHead(status, { 'content-type': 'application/problem+json' })
          .end(JSON.stringify(problem.toBody(req.requestId, req.originalUrl)));
      },
    },
  });

  // `http-proxy-middleware` reports its own failures through `on.error`, so the
  // promise its middleware returns carries nothing to await.
  return (req, res, next) => {
    Promise.resolve(proxy(req, res, next)).catch(next);
  };
}
