import type { Express } from 'express';
import type { Server } from 'node:http';
import type { Logger } from './logger.ts';

/**
 * Starting and stopping a service.
 *
 * The shutdown sequence is copied from the model repo, which got this right in
 * all ten of its services: close the listener, then force the process out if
 * draining takes too long. Without the timer a single hung request keeps a
 * terminating container alive until the orchestrator kills it, which turns an
 * ordinary deploy into a gap in service.
 *
 * What is added here is the order. Connections are closed *before* the database
 * pool, so an in-flight request still has a working connection to finish on.
 */

export interface StartOptions {
  readonly app: Express;
  readonly port: number;
  readonly serviceName: string;
  readonly logger: Logger;
  /** Released after the listener has drained. */
  readonly onShutdown?: () => Promise<void>;
  /** How long draining may take. */
  readonly graceMs?: number;
}

export function start(options: StartOptions): Server {
  const { app, port, serviceName, logger } = options;
  const graceMs = options.graceMs ?? 10_000;

  const server = app.listen(port, () => {
    logger.info({ port }, `${serviceName} listening`);
  });

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    // A second SIGTERM during a slow drain should not restart the sequence.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, `${serviceName} shutting down`);

    const forced = setTimeout(() => {
      logger.error({ graceMs }, 'drain timed out; exiting anyway');
      process.exit(1);
    }, graceMs);
    // Do not let the timer itself hold the event loop open.
    forced.unref();

    server.close((error) => {
      void (async () => {
        if (error) logger.error({ err: error }, 'server close failed');
        try {
          await options.onShutdown?.();
        } catch (cause) {
          logger.error({ err: cause }, 'shutdown hook failed');
        }
        clearTimeout(forced);
        logger.info(`${serviceName} stopped`);
        process.exit(error ? 1 : 0);
      })();
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // An unhandled rejection has already escaped every catch in the request path.
  // Log it and let the platform restart a process whose state is unknown.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });

  return server;
}
