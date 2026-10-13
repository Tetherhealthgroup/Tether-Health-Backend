import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changeNotification,
  fanOut,
  shouldDeliver,
  toSseFrame,
  type ChangeNotification,
  type Subscriber,
} from '../src/subscriptions.ts';

const MINE = '11111111-1111-4111-8111-111111111111';
const THEIRS = '22222222-2222-4222-8222-222222222222';

function subscriber(
  enrolmentIds: string[],
  sink: ChangeNotification[] = [],
  alive = true,
): Subscriber {
  return {
    accountId: 'acct-1',
    enrolmentIds: new Set(enrolmentIds),
    send: (event) => {
      if (!alive) return false;
      sink.push(event);
      return true;
    },
  };
}

const event = (over: Partial<ChangeNotification> = {}): ChangeNotification => ({
  enrolmentId: MINE,
  table: 'record.observation',
  op: 'insert',
  at: '2026-09-14T12:00:00Z',
  ...over,
});

void test('a notification carries no row data', () => {
  // The security property the whole design rests on. If a payload ever grows a
  // value column, a stream becomes a read path with no consent check in it.
  const parsed = changeNotification.parse({
    enrolmentId: MINE,
    table: 'record.observation',
    op: 'insert',
    at: '2026-09-14T12:00:00Z',
  });

  assert.deepEqual(Object.keys(parsed).sort(), [
    'at',
    'enrolmentId',
    'op',
    'table',
  ]);
});

void test('a subscriber hears about its own enrolments', () => {
  assert.equal(shouldDeliver(subscriber([MINE]), event()), true);
});

void test('a subscriber hears nothing about anyone else', () => {
  assert.equal(
    shouldDeliver(subscriber([MINE]), event({ enrolmentId: THEIRS })),
    false,
  );
});

void test('a revocation still reaches a subscriber who just lost access', () => {
  // The case that has to be special. A clinician's allow-list was resolved at
  // connect; when consent is revoked the enrolment leaves it, and a plain
  // "not yours" rule would drop the very event telling them to close the view.
  // "Revocation is enforced rather than merely recorded."
  const revocation = event({
    enrolmentId: THEIRS,
    table: 'programme.sharing_consent',
    op: 'update',
    revoked: true,
  });

  assert.equal(shouldDeliver(subscriber([MINE]), revocation), true);
});

void test('a consent *grant* for someone else is not leaked', () => {
  // The mirror of the above, and the thing a careless fix would get wrong:
  // only revocation is exempt. Learning that a stranger granted consent to
  // somebody is itself a disclosure.
  const grant = event({
    enrolmentId: THEIRS,
    table: 'programme.sharing_consent',
    op: 'insert',
    revoked: false,
  });

  assert.equal(shouldDeliver(subscriber([MINE]), grant), false);
});

void test('fan-out delivers only to the entitled', () => {
  const mineSink: ChangeNotification[] = [];
  const theirsSink: ChangeNotification[] = [];

  fanOut(
    [subscriber([MINE], mineSink), subscriber([THEIRS], theirsSink)],
    event(),
  );

  assert.equal(mineSink.length, 1);
  assert.equal(theirsSink.length, 0);
});

void test('fan-out reports sockets that have gone', () => {
  const dead = subscriber([MINE], [], false);
  const alive = subscriber([MINE]);

  const gone = fanOut([dead, alive], event());

  assert.deepEqual(gone, [dead]);
});

void test('an SSE frame is terminated', () => {
  // A frame without the blank line is the classic reason a stream appears to
  // hang: the client holds it, waiting for an end that never comes.
  const frame = toSseFrame(event());

  assert.ok(frame.endsWith('\n\n'), 'frame is not terminated');
  assert.match(frame, /^event: change\n/);
  assert.match(frame, /\nid: 2026-09-14T12:00:00Z\n/);

  const data = /\ndata: (.+)\n\n$/.exec(frame)?.[1];
  assert.deepEqual(JSON.parse(data ?? '{}'), event());
});

void test('the frame is one line of data', () => {
  // SSE splits on newlines, so an embedded one would truncate the event. The
  // payload is JSON with no raw newlines, which is what keeps that safe.
  const frame = toSseFrame(event());
  const dataLines = frame.split('\n').filter((l) => l.startsWith('data: '));
  assert.equal(dataLines.length, 1);
});
