import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import express, { type Express } from "express";
import { createLogger, loadConfig, type Verifier } from "@tether/core";
import { openApiDocument } from "../../../packages/contracts/src/emit-openapi.ts";
import { createAuthRouter } from "../../auth-service/src/routes.ts";
import { catalogueRoutes } from "../../catalogue-service/src/routes.ts";
import { enrolmentRoutes } from "../../enrolment-service/src/routes.ts";
import { createRecordsApp } from "../../records-service/src/app.ts";
import { createCareTeamApp } from "../../care-team-service/src/app.ts";
import {
  DEFERRED_ROUTES,
  ROUTES,
  matchesPrefix,
  routeFor,
  stripServicePrefix,
} from "../src/routes.ts";

/**
 * The gateway's path rewrite composed with each service's real routes.
 *
 * `routes.test.ts` proves which service a public path selects and what the
 * path becomes. Each service's own tests prove its routes answer at the paths
 * it mounts them. Neither says whether the first output is an input the second
 * recognises, and that join is where a public path can 404 while every unit
 * test is green (BE-049, OPS-020 section 4.1).
 *
 * What is composed, with no socket opened anywhere:
 *
 *   public path -> `routeFor` -> `stripServicePrefix` (the two functions
 *   `src/proxy.ts` calls in `pathFilter` and `pathRewrite`) -> the service's
 *   real Express routes, called in-process.
 *
 * "Reaches a handler" means the request is not answered by the 404 that falls
 * out of the end of the router. Every request here is sent without credentials,
 * so a guarded route answers 401 and a public one 400/401/etc.; none of them
 * gets as far as the database, which is a stub that throws if touched.
 *
 * Five services export a router or app and are composed for real. Four
 * (notification, website, chronic, realtime) build their routes inline in an
 * `index.ts` that connects to Postgres at import, so they cannot be imported
 * from a test. Their route literals are read from the source text instead and
 * matched against the rewritten path; that is a weaker check and is reported as
 * a source scan in the failure detail.
 */

// ---------------------------------------------------------------------------
// In-process dispatch
// ---------------------------------------------------------------------------

interface Outcome {
  /** True when the request fell off the end of the app without a handler. */
  readonly unmatched: boolean;
  readonly status: number;
}

/** Runs one request through an Express app without opening a socket. */
function dispatch(app: Express, method: string, url: string): Promise<Outcome> {
  const socket = new Socket();
  // `express-rate-limit` reads `req.ip`, which comes from the socket.
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  req.headers = { host: "service.internal" };
  const res = new ServerResponse(req);

  return new Promise<Outcome>((resolve, reject) => {
    res.on("finish", () =>
      resolve({ unmatched: false, status: res.statusCode }),
    );
    // Without a socket the `finish` event never fires, so also hook `end`.
    const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
    res.end = ((...args: unknown[]) => {
      const out = end(...args);
      resolve({ unmatched: false, status: res.statusCode });
      return out;
    }) as typeof res.end;
    req.push(null);
    app(req as never, res as never, (error?: unknown) => {
      if (error === undefined) return resolve({ unmatched: true, status: 404 });
      // A bare router has no error handler, so a handler that refuses the
      // request (here: the 401 for a missing token) hands its problem to
      // `next`. That is a handler having run, not a route being absent.
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number")
        return resolve({ unmatched: false, status });
      return reject(
        error instanceof Error
          ? error
          : new Error("a handler passed a non-Error to next"),
      );
    });
  });
}

/** A database that fails the test if any handler gets as far as using it. */
const noDatabase = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`a handler reached the database (${String(property)})`);
    },
  },
);

const noVerifier: Verifier = () =>
  Promise.reject(new Error("no token is ever presented"));

const config = loadConfig(undefined, {
  NODE_ENV: "test",
  SERVICE_NAME: "composition-test",
  PORT: "8000",
  LOG_LEVEL: "fatal",
  JWT_ISSUER: "https://issuer.test",
  JWT_AUDIENCE: "tether",
  JWT_JWKS_URL: "https://issuer.test/jwks.json",
  DATABASE_URL: "postgres://unused/in/this/test",
  RATE_LIMIT_MAX: "100000",
});
const logger = createLogger({
  serviceName: "composition-test",
  level: "fatal",
  environment: "test",
});

/** A bare app with the router mounted at the root, as each `index.ts` does. */
function mountedAtRoot(router: express.Router): Express {
  const app = express();
  app.use(router);
  return app;
}

const SERVICE_APPS: Readonly<Record<string, Express>> = {
  "auth-service": mountedAtRoot(
    createAuthRouter({
      db: noDatabase as never,
      sessions: noDatabase as never,
      // The JWKS route is public and answers from this, so it needs a real value.
      signer: { jwks: { keys: [] } } as never,
      supabase: noVerifier,
      tether: noVerifier,
      refreshTtlDays: 30,
    }),
  ),
  "catalogue-service": mountedAtRoot(
    catalogueRoutes({ db: noDatabase as never, verifier: noVerifier }),
  ),
  "enrolment-service": mountedAtRoot(
    enrolmentRoutes({ db: noDatabase as never, verifier: noVerifier }),
  ),
  "records-service": createRecordsApp({
    config,
    logger,
    verifier: noVerifier,
    db: noDatabase as never,
    store: noDatabase as never,
  }),
  "care-team-service": createCareTeamApp({
    config,
    logger,
    verifier: noVerifier,
    db: noDatabase as never,
    store: noDatabase as never,
  }),
};

/** Services whose routes cannot be imported and are read from their `src/` text. */
const INLINE_SERVICES: readonly string[] = [
  "notification-service",
  "website-service",
  "chronic-service",
  "realtime-service",
];

/**
 * Route literals declared in any `src/*.ts` of the service. Every file is read,
 * not just `index.ts`, so the scan still finds the routes if a service moves
 * them into `src/app.ts` (as BE-001 does for website and chronic).
 */
function inlineRoutes(
  service: string,
): Array<{ method: string; pattern: RegExp }> {
  assert.ok(
    INLINE_SERVICES.includes(service),
    `${service} is not a source-scanned service`,
  );
  const directory = new URL(`../../${service}/src/`, import.meta.url);
  const found: Array<{ method: string; pattern: RegExp }> = [];
  for (const file of readdirSync(directory).filter((name) =>
    name.endsWith(".ts"),
  )) {
    const source = readFileSync(new URL(file, directory), "utf8");
    const declaration =
      /\b(?:app|router|routes)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
    for (const match of source.matchAll(declaration)) {
      const regex = (match[2] ?? "").replace(/:[A-Za-z]+/g, "[^/]+");
      found.push({
        method: (match[1] ?? "").toUpperCase(),
        // Express matches paths case-insensitively and without a trailing slash
        // by default, so the scan has to as well.
        pattern: new RegExp(`^${regex}/?$`, "i"),
      });
    }
  }
  assert.ok(found.length > 0, `no routes found in ${service}/src`);
  return found;
}

// ---------------------------------------------------------------------------
// The documented public paths
// ---------------------------------------------------------------------------

interface Documented {
  readonly method: string;
  readonly path: string;
  /** Where the path is documented. */
  readonly source: string;
}

const SAMPLE: Readonly<Record<string, string>> = {
  areaId: "tobacco",
  archetypeId: "a1",
  productId: "breathefree",
  locale: "en",
};

/**
 * The OpenAPI document lists each route as the service mounts it, without the
 * gateway's `/api/v1/...` prefix. Catalogue routes are public under
 * `/api/v1/catalogue` (`/areas` -> `/api/v1/catalogue/areas`); enrolment paths
 * already begin with the resource name the gateway prefix ends in, so they are
 * public under `/api/v1` (`/enrolments` -> `/api/v1/enrolments`).
 */
const OPENAPI_PUBLIC_BASE: Readonly<Record<string, string>> = {
  catalogue: "/api/v1/catalogue",
  enrolment: "/api/v1",
};

function openApiDocumented(): Documented[] {
  const paths = openApiDocument()["paths"] as Record<
    string,
    Record<string, { tags: string[] }>
  >;
  const out: Documented[] = [];
  for (const [path, operations] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const base = OPENAPI_PUBLIC_BASE[operation.tags[0] ?? ""];
      assert.ok(
        base,
        `OpenAPI operation ${method} ${path} has an unmapped tag`,
      );
      const concrete = path.replace(
        /\{(\w+)\}/g,
        (_m, name: string) => SAMPLE[name] ?? "x1",
      );
      out.push({
        method: method.toUpperCase(),
        path: `${base}${concrete}`,
        source: `packages/contracts/src/emit-openapi.ts ${method} ${path}`,
      });
    }
  }
  return out;
}

/** Documented outside the OpenAPI document: the service route files, the gateway tests and ARCHITECTURE.md. */
const OTHER_DOCUMENTED: readonly Documented[] = [
  {
    method: "POST",
    path: "/api/v1/auth/sessions",
    source: "auth-service/src/routes.ts:110",
  },
  {
    method: "POST",
    path: "/api/v1/auth/sessions/refresh",
    source: "auth-service/src/routes.ts:144",
  },
  {
    method: "DELETE",
    path: "/api/v1/auth/sessions",
    source: "auth-service/src/routes.ts:216",
  },
  {
    method: "GET",
    path: "/api/v1/auth/me",
    source: "auth-service/src/routes.ts:241",
  },
  {
    method: "DELETE",
    path: "/api/v1/auth/me",
    source: "auth-service/src/routes.ts:269",
  },
  {
    method: "GET",
    path: "/api/v1/auth/.well-known/jwks.json",
    source: "api-gateway/test/routes.test.ts:49",
  },
  {
    method: "GET",
    path: "/api/v1/records/tobacco/answers",
    source: "records-service/src/app.ts:138",
  },
  {
    method: "POST",
    path: "/api/v1/records/sync",
    source: "records-service/src/app.ts:333",
  },
  {
    method: "GET",
    path: "/api/v1/records/export",
    source: "records-service/src/app.ts:390",
  },
  {
    method: "DELETE",
    path: "/api/v1/records/record",
    source: "records-service/src/app.ts:430",
  },
  {
    method: "GET",
    path: "/api/v1/care/patients",
    source: "care-team-service/src/app.ts:148",
  },
  {
    method: "POST",
    path: "/api/v1/care/escalations",
    source: "care-team-service/src/app.ts:309",
  },
  {
    method: "POST",
    path: "/api/v1/notifications/devices",
    source: "notification-service/src/index.ts:172",
  },
  {
    method: "GET",
    path: "/api/v1/notifications/preferences",
    source: "notification-service/src/index.ts:223",
  },
  {
    method: "GET",
    path: "/api/v1/chronic/profile",
    source: "chronic-service/src/index.ts:147",
  },
  {
    method: "GET",
    path: "/api/v1/chronic/medications",
    source: "chronic-service/src/index.ts:299",
  },
  // website-service serves `POST /waitlist` (website-service/src/index.ts:126),
  // and the waitlist is its one job (ARCHITECTURE.md:58). realtime-service
  // serves `GET /stream` (realtime-service/src/index.ts:126). Both prefixes are in
  // `DEFERRED_ROUTES` (src/routes.ts:97-98), so these are unreachable on
  // purpose: see KNOWN_UNREACHABLE.
  {
    method: "POST",
    path: "/api/v1/waitlist",
    source: "website-service/src/index.ts:126",
  },
  {
    method: "GET",
    path: "/api/v1/stream",
    source: "realtime-service/src/index.ts:126",
  },
];

// ---------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------

async function reachesHandler(
  documented: Documented,
): Promise<{
  service: string;
  forwarded: string;
  reached: boolean;
  detail: string;
}> {
  const route = routeFor(documented.path);
  if (!route) {
    // Not forwarded: the gateway answers 404 (or 401 first when a token is
    // required). Only a deferred prefix may be absent from the table.
    assert.ok(
      DEFERRED_ROUTES.some((deferred) => matchesPrefix(deferred.prefix, documented.path)),
      `no gateway route serves ${documented.path}`,
    );
    return {
      service: "none",
      forwarded: documented.path,
      reached: false,
      detail: "not forwarded: deferred prefix",
    };
  }
  const forwarded = stripServicePrefix(route.prefix, documented.path);

  const app = SERVICE_APPS[route.service];
  if (app) {
    const outcome = await dispatch(app, documented.method, forwarded);
    return {
      service: route.service,
      forwarded,
      reached: !outcome.unmatched && outcome.status !== 404,
      detail: `status ${outcome.status}${outcome.unmatched ? " (fell off the router)" : ""}`,
    };
  }

  const pathOnly = forwarded.split("?")[0] ?? forwarded;
  const reached = inlineRoutes(route.service).some(
    (candidate) =>
      candidate.method === documented.method &&
      candidate.pattern.test(pathOnly),
  );
  return {
    service: route.service,
    forwarded,
    reached,
    detail: "source scan of src/*.ts",
  };
}

const ALL_DOCUMENTED: readonly Documented[] = [
  ...openApiDocumented(),
  ...OTHER_DOCUMENTED,
];

/**
 * Documented public paths that do not reach a handler today, on purpose.
 *
 * The gateway does not forward them: `/api/v1/waitlist` and `/api/v1/stream` are
 * in `DEFERRED_ROUTES`, absent from `ROUTES`, so they and everything beneath
 * them answer 404 at the gateway (401 first for a path that needs a token).
 * Mapping them would make them reachable, and with them two open R-033 holes
 * (compliance/risk-register.md:45): website-service's unauthenticated
 * `DELETE /waitlist/:id` (the gateway allowlist exempts all of
 * `/api/v1/waitlist/*`) and realtime-service's revocation broadcast to every
 * subscriber. R-033 is fixed only in BE-001, so mapping them is deferred to a
 * follow-up ticket that depends on BE-001.
 *
 * Correction to BE-049: it described these as unreachable because the bare
 * prefix is forwarded as `/`, which both services 404. That was true of the
 * documented paths only. The doubled forms `DELETE /api/v1/waitlist/waitlist/<id>`
 * (public, no token) and `GET /api/v1/stream/stream` (any valid token) were
 * forwarded as `/waitlist/<id>` and `/stream` and did reach the holes. They are
 * refused now because the prefixes are not routed at all; the tests below cover
 * the spellings.
 *
 * The test asserts the unreachable set equals this list exactly: a new
 * unreachable path fails it, and so does one of these becoming reachable
 * without this list being updated.
 */
const KNOWN_UNREACHABLE: readonly string[] = [
  // Deferred until BE-001 because of R-033 (compliance/risk-register.md:45).
  "POST /api/v1/waitlist",
  // Deferred until BE-001 because of R-033 (compliance/risk-register.md:45).
  "GET /api/v1/stream",
];

void test("every documented public path reaches a handler, except the two the gateway does not forward until BE-001", async () => {
  const unreachable = new Map<string, string>();
  for (const documented of ALL_DOCUMENTED) {
    const result = await reachesHandler(documented);
    if (!result.reached) {
      unreachable.set(
        `${documented.method} ${documented.path}`,
        `${documented.method} ${documented.path} -> ${result.service} as ${result.forwarded} ` +
          `[${result.detail}] (documented at ${documented.source})`,
      );
    }
  }
  assert.deepEqual(
    [...unreachable.keys()].sort(),
    [...KNOWN_UNREACHABLE].sort(),
    `unreachable public paths differ from KNOWN_UNREACHABLE:\n${[...unreachable.values()].join("\n")}`,
  );
});

void test("the composition can tell a missing route from a present one", async () => {
  // Guards the test itself: a dispatcher that answered 401 for everything
  // would make the check above vacuous.
  const enrolment = SERVICE_APPS["enrolment-service"];
  assert.ok(enrolment);
  const present = await dispatch(enrolment, "GET", "/enrolments");
  assert.equal(present.unmatched, false);
  assert.equal(present.status, 401);
  const absent = await dispatch(enrolment, "GET", "/definitely-not-a-route");
  assert.equal(absent.unmatched, true);

  const records = SERVICE_APPS["records-service"];
  assert.ok(records);
  assert.equal(
    (await dispatch(records, "GET", "/definitely-not-a-route")).status,
    404,
  );
  assert.equal((await dispatch(records, "GET", "/export")).status, 401);
});

void test("src/proxy.ts rewrites with the same function this test composes", () => {
  // The composition calls `stripServicePrefix(route.prefix, url)`. If the proxy
  // stopped calling exactly that, the test would be checking a path the gateway
  // does not take.
  const proxy = readFileSync(
    new URL("../src/proxy.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    proxy,
    /pathRewrite:\s*\(path\)\s*=>\s*stripServicePrefix\(route\.prefix,\s*path\)/,
  );
});

// ---------------------------------------------------------------------------
// Doubled prefixes and deferred prefixes (BE-053, R-033)
// ---------------------------------------------------------------------------

/**
 * The prefixes the gateway must not forward at all until the BE-001 follow-up
 * maps them. Spelled out here, independently of `src/routes.ts`, so the test
 * cannot pass by the table and the expectation drifting together; a test below
 * cross-checks the two.
 */
const DEFERRED_PREFIXES: readonly string[] = [
  "/api/v1/waitlist",
  "/api/v1/stream",
];

const SYNTHETIC_ID = "00000000-0000-4000-8000-000000000000";

/** Every spelling of a path under a deferred prefix that an attacker could try. */
function deferredVariants(): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  for (const prefix of DEFERRED_PREFIXES) {
    const word = prefix.split("/").pop() ?? "";
    const upper = prefix.replace(word, word.toUpperCase());
    const title = prefix.replace(word, `${word[0]?.toUpperCase()}${word.slice(1)}`);
    const encoded = prefix.replace(word, `%${word.charCodeAt(0).toString(16)}${word.slice(1)}`);
    const paths = [
      prefix,
      `${prefix}/`,
      `${prefix}?x=1`,
      `${prefix}/${word}`,
      `${prefix}/${word}/`,
      `${prefix}/${word}//`,
      `${prefix}/${word}?x=1`,
      `${prefix}/${word}/${SYNTHETIC_ID}`,
      `${prefix}/${word}/${SYNTHETIC_ID}/`,
      `${prefix}/${word.toUpperCase()}`,
      `${prefix}/${word.toUpperCase()}/${SYNTHETIC_ID}`,
      `${prefix}/${word[0]?.toUpperCase()}${word.slice(1)}/`,
      `${prefix}//${word}`,
      `${prefix}//${word}//${SYNTHETIC_ID}`,
      `${prefix}/${encoded.split("/").pop()}/${SYNTHETIC_ID}`,
      `${prefix}/%2e%2e/${word}`,
      `${prefix}/${SYNTHETIC_ID}`,
      `${prefix}/purge`,
      // the prefix itself, in other spellings
      upper,
      `${upper}/${SYNTHETIC_ID}`,
      title,
      `${title}/${word}/`,
      `${encoded}/${SYNTHETIC_ID}`,
      `${prefix}/`.replace("/api/v1/", "/api/v1//"),
    ];
    for (const path of paths) {
      for (const method of methods) out.push({ method, path });
    }
  }
  return out;
}

void test("no path under a deferred prefix is forwarded by the gateway (R-033)", () => {
  const forwarded = deferredVariants().filter(({ path }) => routeFor(path) !== null);
  assert.deepEqual(
    forwarded.map(({ method, path }) => `${method} ${path} -> ${routeFor(path)?.service}`),
    [],
    "these would reach a service handler, bypassing the R-033 deferral",
  );
});

void test("the named R-033 holes are not forwarded", () => {
  for (const [method, path] of [
    ["DELETE", `/api/v1/waitlist/waitlist/${SYNTHETIC_ID}`],
    ["POST", "/api/v1/waitlist/waitlist"],
    ["GET", "/api/v1/stream/stream"],
    ["DELETE", `/api/v1/waitlist/WAITLIST/${SYNTHETIC_ID}`],
    ["GET", "/api/v1/stream/stream/"],
  ] as const) {
    assert.equal(routeFor(path), null, `${method} ${path}`);
  }
});

void test("the doubled service prefix of every routed service does not reach a handler", async () => {
  const reached: string[] = [];
  for (const route of ROUTES) {
    const segment = route.prefix.split("/").pop() ?? "";
    const spellings = [
      `${route.prefix}/${segment}`,
      `${route.prefix}/${segment}/`,
      `${route.prefix}/${segment.toUpperCase()}`,
      `${route.prefix}/${segment}/${SYNTHETIC_ID}`,
      `${route.prefix}//${segment}`,
      `${route.prefix}/${segment}?x=1`,
    ];
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of spellings) {
        const matched = routeFor(path);
        if (matched === null) continue;
        const forwarded = stripServicePrefix(matched.prefix, path);
        const app = SERVICE_APPS[matched.service];
        let hit: boolean;
        if (app) {
          const outcome = await dispatch(app, method, forwarded);
          hit = !outcome.unmatched && outcome.status !== 404;
        } else {
          const pathOnly = forwarded.split("?")[0] ?? forwarded;
          hit = inlineRoutes(matched.service).some(
            (candidate) =>
              candidate.method === method && candidate.pattern.test(pathOnly),
          );
        }
        // `PATCH /enrolments/:areaId` is a real route, so `/enrolments/enrolments`
        // is that route with `areaId = "enrolments"`: guarded by the token check,
        // and a 404 from the service's own lookup after it. A path parameter
        // legitimately takes any one segment; it is not a doubled prefix reaching
        // a different handler.
        const isAreaParameter =
          matched.service === "enrolment-service" &&
          method === "PATCH" &&
          /^\/enrolments\/[^/?]+\/?(\?.*)?$/.test(forwarded);
        if (hit && !isAreaParameter) {
          reached.push(`${method} ${path} -> ${matched.service} as ${forwarded}`);
        }
      }
    }
  }
  assert.deepEqual(reached, [], "a doubled prefix reaches a service handler");
});

void test("the enrolment prefix is still routed and its doubled form reaches no handler", async () => {
  const enrolment = SERVICE_APPS["enrolment-service"];
  assert.ok(enrolment);
  const forwardedOf = (path: string): string => {
    const route = routeFor(path);
    assert.ok(route, path);
    return stripServicePrefix(route.prefix, path);
  };
  assert.equal(routeFor("/api/v1/enrolments")?.service, "enrolment-service");
  const doubled = await dispatch(
    enrolment,
    "GET",
    forwardedOf("/api/v1/enrolments/enrolments"),
  );
  assert.equal(doubled.unmatched, true);
});

void test("src/app.ts mounts a proxy for each ROUTES entry and nothing else", () => {
  // Deferral is enforced by what `ROUTES` contains, because `src/app.ts` builds
  // its proxies from it. `routeFor` is not on the request path, so a deferred
  // flag that only `routeFor` honoured would leave the gateway forwarding.
  const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  assert.match(app, /for \(const route of ROUTES\) \{/);
  assert.equal((app.match(/createServiceProxy\(/g) ?? []).length, 1);
});

void test("DEFERRED_PREFIXES here and DEFERRED_ROUTES in src/routes.ts agree, and none is also routed", () => {
  assert.deepEqual(
    DEFERRED_ROUTES.map((route) => route.prefix).sort(),
    [...DEFERRED_PREFIXES].sort(),
  );
  for (const deferred of DEFERRED_ROUTES) {
    assert.equal(
      ROUTES.some(
        (route) =>
          route.prefix === deferred.prefix ||
          route.service === deferred.service ||
          route.urlKey === deferred.urlKey,
      ),
      false,
      `${deferred.prefix} is both routed and deferred`,
    );
  }
  // Every deferred path in KNOWN_UNREACHABLE is under a deferred prefix.
  for (const entry of KNOWN_UNREACHABLE) {
    const path = entry.split(" ")[1] ?? "";
    assert.ok(DEFERRED_PREFIXES.some((prefix) => matchesPrefix(prefix, path)), entry);
  }
});
