import { test } from 'node:test';
import assert from 'node:assert/strict';
import { problem, ProblemError, ProblemType, setProblemBase } from '../src/errors.ts';

/**
 * The problem body, and the one distinction in it that is easy to get wrong.
 *
 * `context` is for the log. `extensions` go on the wire. They were one field
 * to begin with, which meant the two-programme-ceiling refusal could not tell
 * the client which programme it would pause — the value was there, and nothing
 * serialised it.
 */

void test('context stays out of the body', () => {
  const error = new ProblemError(ProblemType.internal, 500, 'nope', {
    context: { query: 'SELECT * FROM record.observation', accountId: 'abc' },
  });

  const body = error.toBody('req-1', '/v1/thing');
  assert.equal(body.query, undefined);
  assert.equal(body.accountId, undefined);
  assert.equal(body.detail, 'nope');
});

void test('extensions are serialised', () => {
  const error = problem.atProgrammeCeiling('tobacco');
  const body = error.toBody('req-2', '/v1/enrolments');

  // The client renders this: "Joining this would pause …".
  assert.equal(body.wouldPause, 'tobacco');
  assert.equal(body.status, 409);
  assert.equal(body.title, ProblemType.atProgrammeCeiling);
});

void test('an extension cannot overwrite a reserved member', () => {
  // An `extensions.status` of 200 on a 409 would be worse than no extension at
  // all, so reserved fields are written after the spread.
  const error = new ProblemError(ProblemType.conflict, 409, 'clash', {
    extensions: { status: 200, type: 'https://evil.example/ok', detail: 'fine' },
  });

  const body = error.toBody();
  assert.equal(body.status, 409);
  assert.equal(body.detail, 'clash');
  assert.match(String(body.type), /conflict$/);
});

void test('the type URI resolves under the configured base', () => {
  setProblemBase('https://api.example.test/problems/');
  const body = problem.notFound('gone').toBody();
  assert.equal(body.type, 'https://api.example.test/problems/not-found');
});

void test('validation errors list every failing field at once', () => {
  // One redeploy per missing field is its own kind of outage.
  const body = problem
    .validation('bad', [
      { path: 'email', message: 'required' },
      { path: 'name', message: 'required' },
    ])
    .toBody();

  assert.equal(body.status, 400);
  assert.deepEqual(
    (body.errors ?? []).map((e) => e.path),
    ['email', 'name'],
  );
});
