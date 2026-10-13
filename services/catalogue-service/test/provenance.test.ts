import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction } from '@tether/core';
import { ContentPackResponseSchema, ArchetypeSchema } from '@tether/contracts';
import {
  loadArchetypes,
  loadContentPack,
  toArchetype,
  toScreenContent,
} from '../src/repository.ts';

/**
 * Provenance has to survive the trip.
 *
 * `'supplement'` means the strings were written in the app repository and have
 * not been clinically reviewed. The Flutter client renders a visible NOT
 * CLINICALLY REVIEWED banner on anything so marked, and `provenance` is the
 * only signal it has. If the API stops sending it, the banner stops appearing —
 * and nothing else changes, so nothing else fails. That is the failure this
 * file exists to make loud.
 *
 * The tests below exercise the mappers and the repository against a stub
 * transaction rather than Postgres, because the thing being asserted is the
 * shape of what leaves this service, not that SELECT works.
 */

/** A `Transaction` that answers whichever canned rows match the SQL. */
function stubTransaction(
  answers: ReadonlyArray<readonly [RegExp, readonly unknown[]]>,
): Transaction {
  const rowsFor = (sql: string): unknown[] => {
    const hit = answers.find(([pattern]) => pattern.test(sql));
    if (!hit) throw new Error(`no stubbed answer for: ${sql.trim().slice(0, 80)}`);
    return [...hit[1]];
  };

  return {
    query: async (sql) => rowsFor(sql) as never,
    one: async (sql) => (rowsFor(sql)[0] ?? null) as never,
  };
}

const BUNDLE_ARCHETYPE_ROW = {
  id: 'welcome',
  name: 'Welcome',
  purpose: 'A private, judgment-free opening.',
  chrome: { leading: 'none', badge: false },
  slots: { headline: 'required' },
  actions: [{ kind: 'primary', to: 'why' }],
  requires: ['product_disclaimer'],
  notes: null,
  provenance: 'bundle' as const,
};

const SUPPLEMENT_ARCHETYPE_ROW = {
  id: 'age_gate',
  name: 'Age & floor',
  purpose: 'Establishes an age band before any target is set.',
  chrome: { leading: 'back', badge: true },
  slots: { ageBandControl: 'required' },
  actions: [{ kind: 'primary', to: 'baseline' }],
  requires: ['person_retains_decisions'],
  notes: 'Every string here is unreviewed.',
  provenance: 'supplement' as const,
};

void test('an unreviewed archetype maps to a payload that still says so', () => {
  const mapped = toArchetype(SUPPLEMENT_ARCHETYPE_ROW);

  assert.equal(mapped.provenance, 'supplement');
  // Parsed against the published contract as well as read directly: a schema
  // that made `provenance` optional would let the field be dropped without a
  // test failing anywhere else.
  assert.equal(ArchetypeSchema.parse(mapped).provenance, 'supplement');
});

void test('an unreviewed content screen maps to a payload that still says so', () => {
  const mapped = toScreenContent({
    productId: 'lookup',
    screenId: 'S24',
    locale: 'en',
    body: { headline: 'A quieter phone' },
    provenance: 'supplement',
    updatedAt: new Date('2026-09-12T10:00:00.000Z'),
  });

  assert.equal(mapped.provenance, 'supplement');
  assert.equal(mapped.updatedAt, '2026-09-12T10:00:00.000Z');
});

void test('GET /archetypes carries provenance for every archetype', async () => {
  const tx = stubTransaction([
    [/FROM catalogue\.archetype/, [BUNDLE_ARCHETYPE_ROW, SUPPLEMENT_ARCHETYPE_ROW]],
  ]);

  const archetypes = await loadArchetypes(tx);

  assert.equal(archetypes.length, 2);
  assert.deepEqual(
    archetypes.map((archetype) => [archetype.id, archetype.provenance]),
    [
      ['welcome', 'bundle'],
      ['age_gate', 'supplement'],
    ],
  );
});

void test('a content pack returns supplement screens alongside bundle ones, each marked', async () => {
  const tx = stubTransaction([
    [
      /FROM catalogue\.screen_content/,
      [
        {
          productId: 'lookup',
          screenId: 'S01',
          locale: 'en',
          body: { headline: 'Your attention is yours to spend.' },
          provenance: 'bundle',
          updatedAt: new Date('2026-09-12T10:00:00.000Z'),
        },
        {
          productId: 'lookup',
          screenId: 'S02',
          locale: 'en',
          body: { headline: 'What this does' },
          provenance: 'supplement',
          updatedAt: new Date('2026-09-12T10:00:00.000Z'),
        },
      ],
    ],
  ]);

  const screens = await loadContentPack(tx, 'lookup', 'en');

  // Supplement screens are not filtered out: without them LookUp has ten blank
  // screens. What marks them is the field, not their absence.
  const response = ContentPackResponseSchema.parse({
    productId: 'lookup',
    locale: 'en',
    screens,
  });

  assert.deepEqual(
    response.screens.map((screen) => [screen.screenId, screen.provenance]),
    [
      ['S01', 'bundle'],
      ['S02', 'supplement'],
    ],
  );

  // Belt and braces: no entry may reach a client without the field set.
  for (const screen of response.screens) {
    assert.ok(
      screen.provenance === 'bundle' || screen.provenance === 'supplement',
      `screen ${screen.screenId} lost its provenance`,
    );
  }
});
