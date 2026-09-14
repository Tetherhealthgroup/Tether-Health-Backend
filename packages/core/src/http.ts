import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import type { BaseConfig } from './config.ts';
import { isProblem, problem, ProblemError } from './errors.ts';
import type { Logger } from './logger.ts';
import { bearerToken, type Principal, type Verifier } from './auth.ts';

/**
 * The middleware every service shares.
 *
 * One copy. The repo this is modelled on pasted the same six middlewares into
 * ten `index.ts` files, and they had already drifted — one service allowed a
 * 1 MB body where the other nine allowed 512 KB, and the issuer check existed
 * in the shared file nobody imported but in none of the services. The only way
 * that stays consistent is for there to be one of it.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
      principal?: Principal;
    }
  }
}

export interface AppOptions {
  readonly config: BaseConfig;
  readonly logger: Logger;
  readonly verifier: Verifier;
}

/**
 * Builds an Express app with the standard stack applied, in order.
 *
 * Routes are mounted by the caller afterwards; [finalise] closes it off.
 */
export function createApp(options: AppOptions): Express {
  const { config, logger } = options;
  const app = express();

  // Behind the gateway. Without this, `req.ip` is the gateway for every
  // request and per-IP rate limiting silently becomes global rate limiting.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        // An API returns JSON. Nothing should ever be loaded from it.
        directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] },
      },
      hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // Correlation id, generated if the caller did not bring one, and echoed.
  // Unlike the model repo this is also *consumed* — it goes into the logger and
  // into every problem body, so a patient can quote a failure and it can be
  // found.
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
        // No Origin header: same-origin, curl, or a mobile client. Allowed —
        // CORS is a browser control and rejecting these blocks the apps.
        if (!origin) return callback(null, true);
        if (config.ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        // Deny by not allowing, rather than by erroring: an error here becomes
        // a 500, which reads like an outage rather than a policy.
        return callback(null, false);
      },
      credentials: true,
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: config.BODY_LIMIT }));

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

  return app;
}

/**
 * Requires a verified token.
 *
 * Every service applies this itself. The gateway verifies too, but a service
 * that trusted a header the gateway set would be one network mistake away from
 * trusting anyone who could reach it directly.
 */
export function requireAuth(verifier: Verifier) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = bearerToken(req.header('authorization'));
      if (!token) throw problem.unauthenticated('No bearer token.');
      req.principal = await verifier(token);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Requires one of `roles`. Applied after [requireAuth]. */
export function requireRole(...roles: readonly string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const held = req.principal?.roles ?? [];
    if (roles.some((role) => held.includes(role))) return next();
    next(problem.forbidden('This action needs a different role.'));
  };
}

/** The principal, or a 401. Saves every handler repeating the check. */
export function principalOf(req: Request): Principal {
  if (!req.principal) throw problem.unauthenticated();
  return req.principal;
}

/**
 * Validates `req.body` against `schema` and replaces it with the parsed value.
 *
 * The model repo hand-wrote roughly fifty distinct 400 messages. This produces
 * one shape, lists every failing field at once, and the same schema emits the
 * OpenAPI — so the documentation cannot drift from the check.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(
        problem.validation(
          'The request body is not valid.',
          result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        ),
      );
    }
    req.body = result.data;
    next();
  };
}

/** As [validateBody], for the query string. */
export function validateQuery<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(
        problem.validation(
          'The query string is not valid.',
          result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        ),
      );
    }
    // `req.query` is a getter in Express 5; assign to a field instead.
    (req as Request & { validatedQuery: T }).validatedQuery = result.data;
    next();
  };
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export interface FinaliseOptions {
  readonly serviceName: string;
  /** Readiness check. Liveness is the process being up; this is dependencies. */
  readonly isReady?: () => Promise<boolean>;
}

/**
 * Mounts health endpoints, the 404 and the error handler. Call last.
 *
 * Two health endpoints, not one. The model repo had only `/health`, which
 * returned `UP` whether or not its database was reachable — so an orchestrator
 * could not tell "starting" from "broken", and kept traffic on a service that
 * could not serve it.
 */
export function finalise(app: Express, options: FinaliseOptions): Express {
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'up', service: options.serviceName });
  });

  app.get('/readyz', (req, res) => {
    void (async () => {
      const ready = options.isReady ? await options.isReady() : true;
      res
        .status(ready ? 200 : 503)
        .json({ status: ready ? 'ready' : 'not-ready', service: options.serviceName });
    })().catch(() => {
      req.log.warn('readiness check threw');
      res.status(503).json({ status: 'not-ready', service: options.serviceName });
    });
  });

  app.use((req: Request, _res: Response, next: NextFunction) => {
    next(problem.notFound(`No route for ${req.method} ${req.path}.`));
  });

  app.use(
    (error: unknown, req: Request, res: Response, _next: NextFunction) => {
      const known: ProblemError = isProblem(error) ? error : problem.internal(error);

      if (known.status >= 500) {
        req.log.error(
          { err: error, context: known.context },
          'request failed',
        );
      } else {
        req.log.info(
          { type: known.type, status: known.status, context: known.context },
          'request refused',
        );
      }

      if (res.headersSent) return;
      res
        .status(known.status)
        .type('application/problem+json')
        .json(known.toBody(req.requestId, req.originalUrl));
    },
  );

  return app;
}
