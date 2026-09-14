import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { etagOf, matchesIfNoneMatch, sendCacheable } from '../src/cache.ts';

/**
 * The conditional request is the normal path here, not an optimisation.
 *
 * Every cold start of the Flutter app fetches the whole design bundle. If the
 * ETag is unstable, or `If-None-Match` is compared naively, the 304 never
 * happens and every launch pays for a payload that last changed in March — on a
 * phone that may be on cellular in a waiting room. The tests below are about
 * that, and about one specific way it can silently regress: a wall-clock
 * timestamp inside the body, which changes the hash on every request.
 */

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string | null;
  ended: boolean;
}

function fakeRequest(ifNoneMatch?: string): Request {
  return {
    header: (name: string) =>
      name.toLowerCase() === 'if-none-match' ? ifNoneMatch : undefined,
  } as unknown as Request;
}

function fakeResponse(): { res: Response; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: null, ended: false };
  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return res;
    },
    status(code: number) {
      captured.status = code;
      return res;
    },
    type() {
      return res;
    },
    send(body: string) {
      captured.body = body;
      return res;
    },
    end() {
      captured.ended = true;
      return res;
    },
  } as unknown as Response;
  return { res, captured };
}

test('If-None-Match is honoured as a list, with weak tags and the wildcard', () => {
  const etag = etagOf('{"areas":[]}');

  assert.equal(matchesIfNoneMatch(undefined, etag), false);
  assert.equal(matchesIfNoneMatch(etag, etag), true);
  assert.equal(matchesIfNoneMatch('*', etag), true);

  // A proxy may weaken the validator on the way back out. The body is still the
  // body the client has.
  assert.equal(matchesIfNoneMatch(`W/${etag}`, etag), true);

  // Several candidates, one of which matches — the form a naive `===` misses.
  assert.equal(matchesIfNoneMatch(`"stale", ${etag}, "older"`, etag), true);
  assert.equal(matchesIfNoneMatch('"stale", "older"', etag), false);
});

test('a matching If-None-Match answers 304 with no body, and still sets the validators', () => {
  const body = { areas: [{ id: 'tobacco' }] };
  const etag = etagOf(JSON.stringify(body));

  const { res, captured } = fakeResponse();
  sendCacheable(fakeRequest(etag), res, body);

  assert.equal(captured.status, 304);
  assert.equal(captured.body, null);
  assert.equal(captured.ended, true);

  // The validator has to come back on the 304 too, or the client has nothing to
  // send on the request after this one.
  assert.equal(captured.headers.ETag, etag);
  assert.match(captured.headers['Cache-Control'] ?? '', /max-age=\d+/);
});

test('a non-matching If-None-Match answers 200 with the body', () => {
  const body = { areas: [{ id: 'tobacco' }] };
  const { res, captured } = fakeResponse();

  sendCacheable(fakeRequest('"something-else"'), res, body);

  assert.equal(captured.status, 200);
  assert.equal(captured.body, JSON.stringify(body));
});

test('the same catalogue hashes to the same ETag on every request', () => {
  // The regression this guards: a `generatedAt: new Date()` inside the bundle.
  // It reads as harmless metadata and it defeats the entire endpoint, because
  // the hash is taken over the body and the body would differ every time.
  const bundle = {
    locale: 'en',
    catalogueUpdatedAt: '2026-09-12T10:00:00.000Z',
    areas: [{ id: 'tobacco' }],
    archetypes: [],
    safeguards: [],
    shellRules: [],
    products: [],
    content: [],
  };

  const first = fakeResponse();
  sendCacheable(fakeRequest(), first.res, bundle);

  const second = fakeResponse();
  sendCacheable(fakeRequest(), second.res, bundle);

  assert.equal(first.captured.headers.ETag, second.captured.headers.ETag);

  // And a real change must change it, or the 304 becomes a lie.
  const third = fakeResponse();
  sendCacheable(fakeRequest(), third.res, {
    ...bundle,
    catalogueUpdatedAt: '2026-09-13T10:00:00.000Z',
  });
  assert.notEqual(first.captured.headers.ETag, third.captured.headers.ETag);
});

test('the catalogue is declared publicly cacheable, and says what it varies on', () => {
  const { res, captured } = fakeResponse();
  sendCacheable(fakeRequest(), res, { safeguards: [] });

  // `public` is load-bearing: RFC 9111 §3.5 forbids a shared cache from storing
  // a response to a request carrying `Authorization` unless it is present. It
  // is only safe because this body is byte-identical for every caller and holds
  // no PHI — which is also why `Vary` does not name `Authorization`.
  assert.match(captured.headers['Cache-Control'] ?? '', /\bpublic\b/);
  assert.equal(captured.headers.Vary, 'Accept-Encoding');
});
