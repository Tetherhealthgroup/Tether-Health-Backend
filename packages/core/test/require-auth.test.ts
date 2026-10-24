import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth } from '../src/http.ts';
import { ProblemError } from '../src/errors.ts';
import type { Principal, Verifier } from '../src/auth.ts';

/**
 * `requireAuth` hands Express a synchronous function that runs its async work
 * behind it. What must hold: a bad or missing token reaches `next` as a 401
 * and never as a success, so the handler after it is not reached.
 */

const principal: Principal = { accountId: 'account-a', roles: [], scopes: [], claims: {} };

/** Runs the middleware and resolves with whatever `next` was called with. */
function run(verifier: Verifier, authorization?: string) {
  const req = { header: () => authorization } as unknown as Request;
  return new Promise<{ error: unknown; req: Request }>((resolve) => {
    const next: NextFunction = (error?: unknown) => resolve({ error, req });
    requireAuth(verifier)(req, {} as Response, next);
  });
}

void test('a bearer token the verifier rejects is a 401 and nothing is attached', async () => {
  const rejecting: Verifier = () => Promise.reject(new ProblemError('unauthenticated', 401, 'no'));
  const { error, req } = await run(rejecting, 'Bearer not-valid');
  assert.ok(error instanceof ProblemError);
  assert.equal(error.status, 401);
  assert.equal(req.principal, undefined);
});

void test('a request with no bearer token is a 401 and the verifier is never asked', async () => {
  let asked = false;
  const verifier: Verifier = () => {
    asked = true;
    return Promise.resolve(principal);
  };
  const { error } = await run(verifier, undefined);
  assert.ok(error instanceof ProblemError);
  assert.equal(error.status, 401);
  assert.equal(asked, false);
});

void test('a verified token attaches the principal and calls next with no error', async () => {
  const { error, req } = await run(() => Promise.resolve(principal), 'Bearer good');
  assert.equal(error, undefined);
  assert.equal(req.principal?.accountId, 'account-a');
});
