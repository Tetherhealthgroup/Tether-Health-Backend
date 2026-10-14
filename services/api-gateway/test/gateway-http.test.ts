import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger, loadConfig, type Verifier } from "@tether/core";
import { createGatewayApp } from "../src/app.ts";
import { gatewaySchema } from "../src/config.ts";

/**
 * The gateway's real HTTP stack in front of nine recording servers on
 * 127.0.0.1 (BE-053, R-033).
 *
 * `composition.test.ts` shows the deferred and doubled paths are not in the
 * routing table. This shows what a client sees: the real app, the real token
 * guard and the real proxies, with every `*_SERVICE_URL` pointing at a loopback
 * server that records whatever reaches it. Nothing leaves the machine, and the
 * only token is a synthetic one the injected verifier accepts.
 */

const SYNTHETIC_TOKEN = "synthetic-token-not-a-credential";
const SYNTHETIC_ID = "00000000-0000-4000-8000-000000000000";

const URL_KEYS = [
  "AUTH",
  "CATALOGUE",
  "ENROLMENT",
  "RECORDS",
  "CARE_TEAM",
  "NOTIFICATION",
  "WEBSITE",
  "CHRONIC",
  "REALTIME",
] as const;

const verifier: Verifier = (token) =>
  token === SYNTHETIC_TOKEN
    ? Promise.resolve({
        accountId: "synthetic-account",
        roles: [],
        scopes: [],
        claims: {},
      })
    : Promise.reject(new Error("not the synthetic token"));

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

interface Harness {
  readonly baseUrl: string;
  /** `METHOD /path` lines received by any upstream, keyed by service. */
  readonly received: Record<string, string[]>;
  readonly stop: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const received: Record<string, string[]> = {};
  const servers: Server[] = [];
  const env: Record<string, string> = {
    NODE_ENV: "test",
    SERVICE_NAME: "gateway-http-test",
    PORT: "8000",
    LOG_LEVEL: "fatal",
    JWT_ISSUER: "https://issuer.test",
    JWT_AUDIENCE: "tether",
    JWT_JWKS_URL: "https://issuer.test/jwks.json",
    DATABASE_URL: "postgres://unused/in/this/test",
    RATE_LIMIT_MAX: "100000",
  };

  try {
    for (const key of URL_KEYS) {
      const upstream = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
          (received[key] ??= []).push(`${req.method} ${req.url}`);
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ upstream: key }));
        },
      );
      servers.push(upstream);
      env[`${key}_SERVICE_URL`] = `http://127.0.0.1:${await listen(upstream)}`;
    }

    const config = loadConfig(gatewaySchema, env);
    const logger = createLogger({
      serviceName: "gateway-http-test",
      level: "fatal",
      environment: "test",
    });
    const gateway = createServer(createGatewayApp({ config, logger, verifier }));
    servers.push(gateway);
    const port = await listen(gateway);

    return {
      baseUrl: `http://127.0.0.1:${port}`,
      received,
      stop: async () => {
        await Promise.all(servers.map(close));
      },
    };
  } catch (error) {
    await Promise.all(servers.map(close));
    throw error;
  }
}

function request(
  harness: Harness,
  method: string,
  path: string,
  token: boolean,
): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${SYNTHETIC_TOKEN}` } : {},
    body: method === "POST" ? "{}" : undefined,
  });
}

function assertNothingReceived(harness: Harness): void {
  assert.deepEqual(harness.received, {}, "an upstream received a request");
}

void test("DELETE /api/v1/waitlist/waitlist/<id> with no token is a 404 and reaches no upstream", async () => {
  const harness = await startHarness();
  try {
    const response = await request(
      harness,
      "DELETE",
      `/api/v1/waitlist/waitlist/${SYNTHETIC_ID}`,
      false,
    );
    await response.text();
    assert.equal(response.status, 404);
    assertNothingReceived(harness);
  } finally {
    await harness.stop();
  }
});

void test("POST /api/v1/waitlist/waitlist with no token is a 404 and reaches no upstream", async () => {
  const harness = await startHarness();
  try {
    const response = await request(
      harness,
      "POST",
      "/api/v1/waitlist/waitlist",
      false,
    );
    await response.text();
    assert.equal(response.status, 404);
    assertNothingReceived(harness);
  } finally {
    await harness.stop();
  }
});

void test("GET /api/v1/stream/stream is a 401 without a token and a 404 with one, and reaches no upstream", async () => {
  const harness = await startHarness();
  try {
    const anonymous = await request(harness, "GET", "/api/v1/stream/stream", false);
    await anonymous.text();
    assert.equal(anonymous.status, 401);

    const authenticated = await request(harness, "GET", "/api/v1/stream/stream", true);
    await authenticated.text();
    assert.equal(authenticated.status, 404);

    assertNothingReceived(harness);
  } finally {
    await harness.stop();
  }
});

void test("GET /api/v1/enrolments with a token is forwarded to enrolment-service as /enrolments", async () => {
  const harness = await startHarness();
  try {
    const response = await request(harness, "GET", "/api/v1/enrolments", true);
    await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(harness.received, { ENROLMENT: ["GET /enrolments"] });
  } finally {
    await harness.stop();
  }
});
