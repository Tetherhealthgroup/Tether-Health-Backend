/**
 * `@tether/core` — everything a service needs and should not write twice.
 *
 * One package, resolved through npm workspaces, with the Docker build context
 * set to the repository root so that it is importable from inside an image.
 * Both halves matter: the repo this is modelled on had a `shared/` directory
 * whose build context was the service folder, which made `../../shared`
 * unreachable at build time. Nothing imported it, and it rotted into a
 * 346-line schema describing tables that no longer existed.
 */
export * from './auth.ts';
export * from './config.ts';
export * from './db.ts';
export * from './errors.ts';
export * from './http.ts';
export * from './logger.ts';
export * from './server.ts';
