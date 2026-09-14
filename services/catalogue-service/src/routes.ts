import { Router, type Request } from 'express';
import {
  handler,
  problem,
  requireAuth,
  validateQuery,
  type Database,
  type Verifier,
} from '@tether/core';
import {
  AreasQuerySchema,
  BundleQuerySchema,
  LocaleSchema,
  SlugSchema,
  type AreasQuery,
  type BundleQuery,
} from '@tether/contracts';
import { sendCacheable } from './cache.ts';
import {
  loadArchetype,
  loadArchetypes,
  loadArea,
  loadAreas,
  loadBundle,
  loadContentPack,
  loadProduct,
  loadSafeguards,
  loadShellRules,
} from './repository.ts';

/**
 * The catalogue routes.
 *
 * Every one of them reads through `db.withoutPrincipal`. That is not an
 * oversight about authentication — `requireAuth` is applied below and a caller
 * still needs a verified token. It is that the catalogue holds no row belonging
 * to anybody, so there is no account to scope the transaction to, and setting
 * one would imply a relationship between this data and a person that does not
 * exist. If this service is ever pointed at a PHI table by mistake, RLS sees a
 * connection with no `app.account_id` and returns nothing, which is the outcome
 * you want from a mistake.
 */

export interface RouteOptions {
  readonly db: Database;
  readonly verifier: Verifier;
}

/**
 * Reads a path parameter that must be an identifier.
 *
 * Validated rather than passed straight to a parameterised query. The query is
 * safe either way, but an unvalidated id reaches the 404 message, the audit
 * trail and the logs, and a 2 KB path segment in all three is a nuisance
 * somebody has to clean up later.
 */
function slugParam(req: Request, name: string): string {
  const result = SlugSchema.safeParse(req.params[name]);
  if (!result.success) {
    throw problem.validation(`\`${name}\` is not a valid identifier.`, [
      { path: name, message: result.error.issues[0]?.message ?? 'invalid' },
    ]);
  }
  return result.data;
}

function localeParam(req: Request): string {
  const result = LocaleSchema.safeParse(req.params.locale);
  if (!result.success) {
    throw problem.validation('`locale` is not a valid language tag.', [
      { path: 'locale', message: result.error.issues[0]?.message ?? 'invalid' },
    ]);
  }
  return result.data;
}

/** Reads what [validateQuery] parsed. It does not write to `req.query`. */
function validatedQuery<T>(req: Request): T {
  return (req as Request & { validatedQuery: T }).validatedQuery;
}

export function catalogueRoutes(options: RouteOptions): Router {
  const { db, verifier } = options;
  const router = Router();

  /**
   * Named once and attached per route, rather than `router.use`-d.
   *
   * This router is mounted at the application root, so a `router.use`
   * middleware would run for every request that reaches it — including
   * `/healthz` and `/readyz`, which `finalise` registers afterwards. The
   * orchestrator holds no token, so health checks would answer 401 and the
   * service would look permanently unhealthy while serving perfectly. Attaching
   * it per route keeps the two health endpoints open and every real route
   * closed, and makes which is which visible at the route.
   */
  const auth = requireAuth(verifier);

  router.get(
    '/areas',
    auth,
    validateQuery(AreasQuerySchema),
    handler(async (req, res) => {
      const { status } = validatedQuery<AreasQuery>(req);
      const areas = await db.withoutPrincipal((tx) => loadAreas(tx, { status }));
      sendCacheable(req, res, { areas });
    }),
  );

  router.get(
    '/areas/:areaId',
    auth,
    handler(async (req, res) => {
      const areaId = slugParam(req, 'areaId');
      const area = await db.withoutPrincipal((tx) => loadArea(tx, areaId));
      if (!area) {
        // The app spells it `kidney_liver` and the website spells it
        // `kidney-liver`. Naming the id back is the difference between a client
        // author fixing that in a minute and filing a bug about a missing area.
        throw problem.notFound(`No area with id \`${areaId}\`.`);
      }
      sendCacheable(req, res, area);
    }),
  );

  router.get(
    '/archetypes',
    auth,
    handler(async (req, res) => {
      const archetypes = await db.withoutPrincipal(loadArchetypes);
      sendCacheable(req, res, { archetypes });
    }),
  );

  router.get(
    '/archetypes/:archetypeId',
    auth,
    handler(async (req, res) => {
      const archetypeId = slugParam(req, 'archetypeId');
      const archetype = await db.withoutPrincipal((tx) =>
        loadArchetype(tx, archetypeId),
      );
      if (!archetype) {
        throw problem.notFound(`No archetype with id \`${archetypeId}\`.`);
      }
      sendCacheable(req, res, archetype);
    }),
  );

  router.get(
    '/safeguards',
    auth,
    handler(async (req, res) => {
      const safeguards = await db.withoutPrincipal(loadSafeguards);
      sendCacheable(req, res, { safeguards });
    }),
  );

  router.get(
    '/shell-rules',
    auth,
    handler(async (req, res) => {
      const rules = await db.withoutPrincipal(loadShellRules);
      sendCacheable(req, res, { rules });
    }),
  );

  router.get(
    '/products/:productId',
    auth,
    handler(async (req, res) => {
      const productId = slugParam(req, 'productId');
      const product = await db.withoutPrincipal((tx) => loadProduct(tx, productId));
      if (!product) {
        throw problem.notFound(`No product with id \`${productId}\`.`);
      }
      sendCacheable(req, res, product);
    }),
  );

  router.get(
    '/products/:productId/content/:locale',
    auth,
    handler(async (req, res) => {
      const productId = slugParam(req, 'productId');
      const locale = localeParam(req);

      const pack = await db.withoutPrincipal(async (tx) => {
        const product = await loadProduct(tx, productId);
        if (!product) return null;
        return {
          product,
          screens: await loadContentPack(tx, productId, locale),
        };
      });

      if (!pack) throw problem.notFound(`No product with id \`${productId}\`.`);

      if (pack.screens.length === 0) {
        // Distinguished from an unknown product on purpose. `product.locales`
        // says which locales exist, so "you asked for a locale this product
        // does not have" is answerable, and answering it stops a client
        // retrying a fetch that can never succeed.
        throw problem.notFound(
          `\`${productId}\` has no \`${locale}\` content. It declares ${
            pack.product.locales.join(', ') || 'no locales'
          }.`,
        );
      }

      sendCacheable(req, res, {
        productId,
        locale,
        // Each entry carries its own `provenance`. The ten LookUp screens the
        // bundle does not author are here, marked `supplement`, and the client
        // banners them.
        screens: pack.screens,
      });
    }),
  );

  router.get(
    '/bundle',
    auth,
    validateQuery(BundleQuerySchema),
    handler(async (req, res) => {
      const { locale } = validatedQuery<BundleQuery>(req);
      const bundle = await db.withoutPrincipal((tx) => loadBundle(tx, locale));
      sendCacheable(req, res, bundle);
    }),
  );

  return router;
}
