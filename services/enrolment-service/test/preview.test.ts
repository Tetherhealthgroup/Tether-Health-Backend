import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SharePreviewResponseSchema, type SharingConsent } from '@tether/contracts';
import { previewEntries, projectShare, type PreviewSource } from '../src/repository.ts';
import { liveConsents } from '../src/rules.ts';

/**
 * The `share_preview` safeguard, and revocation being enforced rather than
 * recorded.
 *
 * `share_on_request_only`: "Readings and history go to a clinician only when
 * the person chooses, after previewing what is sent." The preview is therefore
 * a promise about accuracy — whatever it shows is what would go — and the
 * moment a consent is revoked that promise means the entry has to be gone. Not
 * gone at the next cache expiry, not gone from the list but still in the
 * preview: gone.
 */

const SOURCE: PreviewSource = {
  areaId: 'tobacco',
  areaName: 'Tobacco & nicotine',
  status: 'active',
  joinedOn: '2026-01-04T09:00:00.000Z',
  totals: [
    {
      measureId: 'tobacco.craving_intensity',
      label: 'Craving intensity',
      unit: 'scale_0_10',
      count: 12,
      firstObservedAt: '2026-01-05T08:00:00.000Z',
      lastObservedAt: '2026-02-01T08:00:00.000Z',
      latestValue: 4,
    },
  ],
  answersRecorded: 31,
  lapseDates: ['2026-01-19T21:40:00.000Z'],
  notes: [
    {
      screenId: 'S09',
      blockIndex: 0,
      text: 'So I can take the stairs without stopping halfway.',
      answeredAt: '2026-01-04T09:12:00.000Z',
    },
  ],
};

function consent(overrides: Partial<SharingConsent>): SharingConsent {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    enrolmentId: '22222222-2222-4222-8222-222222222222',
    scope: 'totals_and_adherence',
    recipientKind: 'coach',
    recipientId: null,
    consentVersion: '2026-09-01',
    consentText: 'I agree to share my totals and adherence with my coach.',
    grantedAt: '2026-01-06T09:00:00.000Z',
    revokedAt: null,
    ...overrides,
  };
}

void test('a revoked consent disappears from the preview immediately', () => {
  const live = consent({ id: '11111111-1111-4111-8111-111111111111' });
  const revoked = consent({
    id: '33333333-3333-4333-8333-333333333333',
    scope: 'notes',
    recipientKind: 'supporter',
    revokedAt: '2026-02-02T12:00:00.000Z',
  });

  const entries = previewEntries({
    // The repository hands over every consent row, revoked ones included. The
    // filtering is here, in one place, so `GET /sharing` and the preview cannot
    // hold different opinions about what "live" means.
    consents: [live, revoked],
    prospective: null,
    source: SOURCE,
  });

  assert.deepEqual(
    entries.map((entry) => entry.consentId),
    [live.id],
  );

  // The revoked grant was for `notes`, so the person's own words would have
  // been in the payload. They are not in any payload now.
  const everyNote = entries.flatMap((entry) => entry.payload.notes ?? []);
  assert.deepEqual(everyNote, []);

  assert.equal(liveConsents([live, revoked]).length, 1);
});

void test('revoking the last consent empties the preview rather than falling back to a default', () => {
  const entries = previewEntries({
    consents: [consent({ revokedAt: '2026-02-02T12:00:00.000Z' })],
    prospective: null,
    source: SOURCE,
  });

  assert.deepEqual(entries, []);
});

void test('the smaller scope discloses no notes, and says so with null rather than []', () => {
  const totalsOnly = projectShare('totals_and_adherence', SOURCE);

  // null renders as "this recipient would receive none of your own words".
  // [] renders as "you have not written any". Only one of those is true here,
  // and the person is being asked to check exactly this.
  assert.equal(totalsOnly.notes, null);

  assert.equal(totalsOnly.adherence.lapsesRecorded, 1);
  assert.deepEqual(totalsOnly.adherence.lapseDates, ['2026-01-19T21:40:00.000Z']);
  assert.equal(totalsOnly.totals.length, 1);
});

void test('the notes scope is a different disclosure, not a bigger one', () => {
  const notes = projectShare('notes', SOURCE);

  assert.equal(notes.notes?.length, 1);
  assert.equal(
    notes.notes?.[0]?.text,
    'So I can take the stairs without stopping halfway.',
  );

  // "A coach seeing a total is a different disclosure from a coach reading a
  // note." The totals are still there; what changed is that the words are too.
  assert.deepEqual(notes.totals, totalsOf(SOURCE));
});

function totalsOf(source: PreviewSource) {
  return [...source.totals];
}

void test('a prospective preview shows what a grant would send, before it is made', () => {
  const entries = previewEntries({
    consents: [],
    prospective: { scope: 'notes', recipientKind: 'care_team' },
    source: SOURCE,
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.consentId, null);
  assert.equal(entries[0]?.prospective, true);
  assert.equal(entries[0]?.payload.notes?.length, 1);
});

void test('the preview response parses against the published contract, and says nothing was sent', () => {
  const response = SharePreviewResponseSchema.parse({
    areaId: 'tobacco',
    generatedAt: '2026-02-02T12:00:00.000Z',
    nothingWasSent: true,
    entries: previewEntries({
      consents: [consent({})],
      prospective: null,
      source: SOURCE,
    }),
  });

  assert.equal(response.nothingWasSent, true);
  assert.equal(response.entries.length, 1);
});
