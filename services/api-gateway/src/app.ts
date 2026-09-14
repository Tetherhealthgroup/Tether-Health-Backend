import { randomUUID } from 'node:crypto';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import {
  type BaseConfig,
  type Logger,
  type Verifier,
  finalise,
  problem,
  requireAuth,
} from '@tether/core';
import type { GatewayConfig } from './config.ts';
import { createServiceProxy } from './proxy.ts';
import { ROUTES, isPublic } from './routes.ts';

/**
 * The gateway's HTTP stack, assembled by hand.
 *
 * ## Why this is the one service that does not call `createApp`
 *
 * `@tether/core`'s `createApp` mounts, in order: helmet, the request-id and
 * logger middleware, CORS, `express.json()`, and the rate limiter. That order
 * is right for the eight services behind this one, and wrong here for exactly
 * one reason — `express.json()` reads the request stream to completion, and a
 * reverse proxy needs the stream intact. See the long comment in `src/proxy.ts`
 * for what happens when it is not.
 *
 * Two ways out were available and both were rejected:
 *
 * 1. **Call `createApp`, then repair the damage** with
 *    `http-proxy-middleware`'s `fixRequestBody`, which re-serialises
 *    `req.body` onto the outgoing request. It only works for content types the
 *    parser understood, so uploads and anything non-JSON stay broken — and the
 *    breakage is invisible until somebody sends one.
 *
 * 2. **Mount the proxies on an outer app and `app.use(createApp(...))` beneath
 *    them.** An Express app is a valid middleware, so this composes — but a
 *    request matched by a proxy would then never reach the inner app, and the
 *    inner app is where helmet, CORS, the correlation id and the rate limiter
 *    live. Proxied traffic is *all* of the gateway's traffic; exempting it from
 *    the edge middleware exempts everyone.
 *
 * So the stack is written out here, minus the body parser, with the proxies
 * mounted first and `express.json()` mounted after them where it can only ever
 * see a request the gateway is answering itself. The duplication is real and is
 * the cost of the fix; what it is not is *drift*, because every knob below
 * (`BODY_LIMIT`, the rate-limit window and ceiling, the allowed origins) is
 * read from the same `BaseConfig` the shared middleware reads. The numbers
 * cannot diverge between here and `createApp`; only the ordering can, and the
 * ordering diverging is the point.
 */

export interface GatewayAppOptions {
  readonly config: BaseConfig & GatewayConfig;
  readonly logger: Logger;
  readonly verifier: Verifier;
}

export function createGatewayApp(options: GatewayAppOptions): Express {
  const { config, logger, verifier } = options;
  const app = express();

  // The gateway is itself behind a load balancer in production, so the first
  // proxy hop is trusted for `req.ip`. Without this, per-IP rate limiting at
  // the edge becomes one shared global bucket.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] },
      },
      hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // Correlation id, generated if the caller did not bring one. This is the
  // point in the system where it is created, since the gateway is the only
  // host-exposed port — every downstream service receives the id this
  // middleware chose, forwarded by `src/proxy.ts`.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    req.requestId =
      incoming && /^[\w-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    req.log = logger.child({ requestId: req.requestId });
    next();
  });

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (config.ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
      maxAge: 600,
    }),
  );

  app.use(
    rateLimit({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      limit: config.RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (req, res) => {
        const error = problem.rateLimited();
        res
          .status(error.status)
          .type('application/problem+json')
          .json(error.toBody(req.requestId, req.originalUrl));
      },
    }),
  );

  // The edge token check, applied to everything not on the public allowlist.
  app.use(edgeAuth(verifier));

  // ---------------------------------------------------------------------
  // Proxies. Nothing that reads the request body may be mounted above here.
  // ---------------------------------------------------------------------
  for (const route of ROUTES) {
    const target = config[route.urlKey];
    app.use(
      createServiceProxy({
        route,
        target,
        timeoutMs: config.PROXY_TIMEOUT_MS,
      }),
    );
    logger.debug({ prefix: route.prefix, service: route.service }, 'route mounted');
  }

  // ---------------------------------------------------------------------
  // Below this line the request was not claimed by any proxy, so its body is
  // the gateway's to read. `express.json()` lives here, after the proxies,
  // rather than at the top of the stack where Express convention would put it —
  // and it lives here even though no gateway-owned route reads a body today,
  // so that the next person to add one adds it underneath rather than above.
  // ---------------------------------------------------------------------
  app.use(express.json({ limit: config.BODY_LIMIT }));

  // `/healthz` and `/readyz`, the 404 and the problem-details error handler.
  return finalise(app, { serviceName: config.SERVICE_NAME });
}

/**
 * Verifies the bearer token unless the path is on the public allowlist.
 *
 * Verified *again* by every downstream service, and that is not redundancy for
 * its own sake: this check is a filter, not an assertion. Rejecting a forged
 * token here keeps garbage off the internal network and gives one place to
 * measure it, but nothing downstream is told the result — no header is set, no
 * claim is forwarded, and the original `Authorization` header travels onward
 * untouched so each service can reach its own verdict. The gateway being
 * bypassed, or the gateway being wrong, must not be enough.
 */
export function edgeAuth(verifier: Verifier): RequestHandler {
  const guard = requireAuth(verifier);
  return (req, res, next) => {
    if (isPublic(req.method, req.path)) return next();
    return guard(req, res, next);
  };
}
