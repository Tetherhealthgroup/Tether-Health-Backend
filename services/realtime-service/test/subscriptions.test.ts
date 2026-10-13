import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changeNotification,
  dispatch,
  fanOut,
  parseNotification,
  shouldDeliver,
  toSseFrame,
  type ChangeNotification,
  type Subscriber,
} from '../src/subscriptions.ts';

const MINE = '11111111-1111-4111-8111-111111111111';
const THEIRS = '22222222-2222-4222-8222-222222222222';
const SHARED = '33333333-3333-4333-8333-333333333333';

interface Options {
  /** Enrolments the account owns. */
  owned?: string[];
  /** Enrolments shared with it by a live consent. */
  shared?: string[];
  sink?: ChangeNotification[];
  alive?: boolean;
}

function subscriber({
  owned = [],
  shared = [],
  sink = [],
  alive = true,
}: Options = {}): Subscriber {
  return {
    accountId: 'acct-1',
    owned: new Set(owned),
    shared: new Set(shared),
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

const consentEvent = (
  enrolmentId: string,
  op: ChangeNotification['op'],
  revoked: boolean,
): ChangeNotification =>
  event({ enrolmentId, table: 'programme.sharing_consent', op, revoked });

test('a notification carries no row data', () => {
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

test('a subscriber hears about its own enrolments', () => {
  assert.equal(shouldDeliver(subscriber({ owned: [MINE] }), event()), true);
});

test('a subscriber hears nothing about anyone else', () => {
  assert.equal(
    shouldDeliver(subscriber({ owned: [MINE] }), event({ enrolmentId: THEIRS })),
    false,
  );
});

test('a recipient hears record changes on an enrolment shared with them', () => {
  assert.equal(
    shouldDeliver(subscriber({ shared: [SHARED] }), event({ enrolmentId: SHARED })),
    true,
  );
});

test('R-033: a revocation on someone else\'s enrolment is not broadcast to a stranger', () => {
  // The defect. `shouldDeliver` used to return true for any revocation, for any
  // enrolment, to any subscriber, so every connected client learned of every
  // withdrawal of consent on the platform.
  const stranger = subscriber({ owned: [MINE] });
  const revocation = consentEvent(THEIRS, 'update', true);

  assert.equal(shouldDeliver(stranger, revocation), false);
  assert.equal(shouldDeliver(subscriber(), revocation), false);
});

test('a recipient is never handed a consent event synchronously; dispatch settles it', () => {
  // The payload does not say whose consent was revoked (R-063), so whether the
  // event is the recipient's is a database read, and that is dispatch's job.
  const clinician = subscriber({ shared: [SHARED] });

  assert.equal(shouldDeliver(clinician, consentEvent(SHARED, 'update', true)), false);
});

test('a revocation reaches the owner of the enrolment', () => {
  assert.equal(
    shouldDeliver(subscriber({ owned: [MINE] }), consentEvent(MINE, 'update', true)),
    true,
  );
});

test('a consent grant is the owner\'s alone — a co-recipient does not hear it', () => {
  // Learning that somebody else was just granted a share on an enrolment you
  // hold is itself a disclosure, so only a revocation (which ends *your* view)
  // is exempt for a recipient.
  const grant = consentEvent(SHARED, 'insert', false);

  assert.equal(shouldDeliver(subscriber({ shared: [SHARED] }), grant), false);
  assert.equal(shouldDeliver(subscriber({ owned: [SHARED] }), grant), true);
  assert.equal(shouldDeliver(subscriber({ owned: [MINE] }), grant), false);
});

test('fan-out delivers only to the entitled', () => {
  const mineSink: ChangeNotification[] = [];
  const theirsSink: ChangeNotification[] = [];

  fanOut(
    [
      subscriber({ owned: [MINE], sink: mineSink }),
      subscriber({ owned: [THEIRS], sink: theirsSink }),
    ],
    event(),
  );

  assert.equal(mineSink.length, 1);
  assert.equal(theirsSink.length, 0);
});

test('fan-out of a revocation reaches the owner only; recipients are settled by dispatch', () => {
  const owner: ChangeNotification[] = [];
  const recipientSink: ChangeNotification[] = [];
  const bystander: ChangeNotification[] = [];
  const unrelated: ChangeNotification[] = [];

  fanOut(
    [
      subscriber({ owned: [SHARED], sink: owner }),
      subscriber({ shared: [SHARED], sink: recipientSink }),
      subscriber({ owned: [MINE], sink: bystander }),
      subscriber({ sink: unrelated }),
    ],
    consentEvent(SHARED, 'update', true),
  );

  assert.equal(owner.length, 1);
  assert.equal(recipientSink.length, 0);
  assert.equal(bystander.length, 0);
  assert.equal(unrelated.length, 0);
});

test('after a revocation is delivered, the recipient hears nothing more about that enrolment', async () => {
  const sink: ChangeNotification[] = [];
  const clinician = subscriber({ shared: [SHARED], sink });
  const none = async () => false;

  await dispatch([clinician], event({ enrolmentId: SHARED }), none);
  assert.equal(sink.length, 1, 'a change before the revocation is theirs to hear');

  await dispatch([clinician], consentEvent(SHARED, 'update', true), none);
  assert.equal(sink.length, 2, 'the revocation itself is delivered');

  await dispatch([clinician], event({ enrolmentId: SHARED }), none);
  await dispatch([clinician], event({ enrolmentId: SHARED, op: 'delete' }), none);
  assert.equal(sink.length, 2, 'later changes to a withdrawn record are not');
});

test('a revocation does not strip an owner of their own enrolment', async () => {
  const sink: ChangeNotification[] = [];
  const owner = subscriber({ owned: [MINE], sink });

  await dispatch([owner], consentEvent(MINE, 'update', true), async () => false);
  await dispatch([owner], event(), async () => false);

  assert.equal(sink.length, 2, 'the owner still hears changes after a revocation');
});

function recipient(accountId: string, shared: string[], sink: ChangeNotification[] = []): Subscriber {
  return { ...subscriber({ shared, sink }), accountId };
}

test('R-063: a revocation reaches the owner and the recipient whose consent ended, and not one whose consent is live', async () => {
  const owner: ChangeNotification[] = [];
  const revoked: ChangeNotification[] = [];
  const other: ChangeNotification[] = [];

  const kept = recipient('clinician-2', [SHARED], other);
  const lost = recipient('clinician-1', [SHARED], revoked);
  const asked: string[] = [];
  // Only clinician-2 still holds a live consent. The lookup is the only source
  // of that fact: the notification names nobody.
  const holds = async (accountId: string, enrolmentId: string) => {
    asked.push(`${accountId}:${enrolmentId}`);
    return accountId === 'clinician-2';
  };

  const dead = await dispatch(
    [subscriber({ owned: [SHARED], sink: owner }), lost, kept],
    consentEvent(SHARED, 'update', true),
    holds,
  );

  assert.deepEqual(dead, []);
  assert.deepEqual(asked.sort(), [`clinician-1:${SHARED}`, `clinician-2:${SHARED}`]);
  assert.equal(owner.length, 1);
  assert.equal(revoked.length, 1);
  assert.equal(other.length, 0, "another recipient was told somebody else's consent was withdrawn");
  assert.ok(!lost.shared.has(SHARED), 'the revoked recipient kept the enrolment');
  assert.ok(kept.shared.has(SHARED), 'another recipient lost a view they are still entitled to');

  await dispatch([kept], event({ enrolmentId: SHARED }), holds);
  assert.equal(other.length, 1, 'their stream carries on');
});

test('R-063: a recipient is held back before the lookup resolves, so nothing leaks while it runs', async () => {
  const sink: ChangeNotification[] = [];
  const clinician = recipient('clinician-1', [SHARED], sink);
  let release: (value: boolean) => void = () => undefined;
  const pending = dispatch(
    [clinician],
    consentEvent(SHARED, 'update', true),
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );

  // The check is still running: a record change must not reach them.
  assert.ok(!clinician.shared.has(SHARED), 'not held back synchronously');
  await dispatch([clinician], event({ enrolmentId: SHARED }), async () => true);
  assert.equal(sink.length, 0);

  release(true);
  await pending;
  assert.ok(clinician.shared.has(SHARED), 'a live consent was not restored');
  assert.equal(sink.length, 0);
});

test('R-063: a failed lookup fails closed: the recipient is told and dropped', async () => {
  const sink: ChangeNotification[] = [];
  const clinician = recipient('clinician-1', [SHARED], sink);

  await dispatch([clinician], consentEvent(SHARED, 'update', true), async () => {
    throw new Error('connection reset');
  });

  assert.equal(sink.length, 1);
  assert.ok(!clinician.shared.has(SHARED));
});

test('R-063: a dead socket found while settling a revocation is reported', async () => {
  const gone = subscriber({ shared: [SHARED], alive: false });
  const dead = await dispatch([gone], consentEvent(SHARED, 'update', true), async () => false);
  assert.deepEqual(dead, [gone]);
});

test('R-063: grants and non-revocation changes never trigger a lookup', async () => {
  let asked = 0;
  const holds = async () => {
    asked += 1;
    return true;
  };
  const clinician = recipient('clinician-1', [SHARED]);
  await dispatch([clinician], consentEvent(SHARED, 'insert', false), holds);
  await dispatch([clinician], event({ enrolmentId: SHARED }), holds);
  assert.equal(asked, 0);
  assert.ok(clinician.shared.has(SHARED));
});

test('R-063: the payload has no recipient field; one sent by an old trigger is dropped on parse', () => {
  const parsed = changeNotification.parse({
    ...consentEvent(SHARED, 'update', true),
    recipientId: 'someone@example.invalid',
  });
  assert.equal('recipientId' in parsed, false);
  assert.ok(!toSseFrame(parsed).includes('example.invalid'), 'a recipient identifier reached a client frame');
  assert.deepEqual(Object.keys(changeNotification.parse(event())).sort(), ['at', 'enrolmentId', 'op', 'table']);
});

test('fan-out reports sockets that have gone', () => {
  const dead = subscriber({ owned: [MINE], alive: false });
  const alive = subscriber({ owned: [MINE] });

  const gone = fanOut([dead, alive], event());

  assert.deepEqual(gone, [dead]);
});

test('a payload that is not JSON, or not the contract, is dropped rather than thrown', () => {
  assert.equal(parseNotification('{not json'), null);
  assert.equal(parseNotification('{"enrolmentId":"x"}'), null);
  assert.equal(parseNotification('null'), null);

  const good = parseNotification(JSON.stringify(event()));
  assert.deepEqual(good, event());
});

test('an SSE frame is terminated', () => {
  // A frame without the blank line is the classic reason a stream appears to
  // hang: the client holds it, waiting for an end that never comes.
  const frame = toSseFrame(event());

  assert.ok(frame.endsWith('\n\n'), 'frame is not terminated');
  assert.match(frame, /^event: change\n/);
  assert.match(frame, /\nid: 2026-09-14T12:00:00Z\n/);

  const data = /\ndata: (.+)\n\n$/.exec(frame)?.[1];
  assert.deepEqual(JSON.parse(data ?? '{}'), event());
});

test('the frame is one line of data', () => {
  // SSE splits on newlines, so an embedded one would truncate the event. The
  // payload is JSON with no raw newlines, which is what keeps that safe.
  const frame = toSseFrame(event());
  const dataLines = frame.split('\n').filter((l) => l.startsWith('data: '));
  assert.equal(dataLines.length, 1);
});
