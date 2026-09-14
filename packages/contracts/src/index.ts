/**
 * `@tether/contracts` — the wire, described once.
 *
 * Every request body, query string and response in this backend is one of the
 * schemas re-exported here, and `emit-openapi.ts` generates the published
 * OpenAPI document from the same objects. That is the whole reason the package
 * exists: the repo this backend is modelled on hand-wrote roughly fifty bespoke
 * 400 messages and maintained its API documentation separately, so the
 * documentation described an API that had not existed for some time. A schema
 * that is both the check and the document cannot drift from itself.
 *
 * Nothing here imports `@tether/core`. Contracts are data shapes; wiring them
 * to Express is `core`'s job, and keeping the dependency one-way means the
 * OpenAPI emitter does not need a database driver on its import path.
 */
export * from './primitives.ts';
export * from './catalogue.ts';
export * from './enrolment.ts';
