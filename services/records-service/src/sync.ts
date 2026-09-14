import { isProblem } from '@tether/core';
import { decodeScreenAnswers, splitAnswerKey } from './answers.ts';
import type { SyncBody } from './schemas.ts';
import type { EnrolmentRow, RecordStore, StoreContext, SyncReceipt } from './store.ts';

/**
 * `POST /sync` — the offline-first path, and the only route here that is hard.
 *
 * `PRODUCTION_RELEASE_CHECKLIST.md` requires: *"Offline actions synchronize
 * once without duplication."* A phone that spent a week on aeroplane mode will
 * send its whole document, and it will send it again if the response never
 * arrives — because from the phone's side a lost response and a lost request
 * look identical. So "re-sending the same batch is a no-op" is not a nicety; it
 * is the only behaviour under which the client's retry loop is safe to write.
 *
 * Idempotency is built in two layers, because the two failure modes are
 * different and neither layer covers both.
 *
 * **Layer 1 — the batch receipt.** The client names the batch with an
 * `Idempotency-Key` (header or body). Before doing anything the handler takes a
 * transaction-scoped advisory lock on `(account, key)` and looks for a receipt
 * from a previous run. If it finds one it returns that receipt verbatim and
 * writes nothing: same counts, same `syncedAt`, same rejected list, so a client
 * comparing two responses sees one answer rather than two that disagree.
 *
 * The receipt lives in `ops.audit_event` rather than a ledger table of its own,
 * and that is the load-bearing choice: the receipt and the rows it describes are
 * written in *the same transaction*, so there is no window in which a batch is
 * marked applied but is not. A separate ledger written after the fact has that
 * window, and a crash inside it produces the one state nothing can recover
 * from — the client believes the sync landed and the rows are not there.
 *
 * **Layer 2 — per-item identity.** Layer 1 fails the moment the client
 * generates a fresh key for what is really the same work: a reinstall, a
 * cleared queue, a resend after the user force-quit mid-request. So every item
 * also carries an identity of its own:
 *
 *  - *Answers* are keyed `(enrolment_id, screen_id, block_index)` and upserted.
 *    Writing the same answer twice is one row by construction — the schema's
 *    unique key is doing the work, not this file.
 *  - *Lapses and observations* are appends, so they get an insert-if-absent
 *    guard on the event's own content: a lapse is `(enrolment, occurredAt,
 *    severity, context)`, an observation `(enrolment, measure, value, unit,
 *    observedAt, source)`. Those tuples are the entire content of the item as
 *    the client models it, so a re-sent item is byte-identical and collapses.
 *
 * Why content and not the `eventId` the client may send: `record.lapse_event`
 * has no column for a client-supplied id, and this service does not own the
 * migration that would add one — `db/migrations/0003` belongs to the schema, not
 * here. An `eventId` is therefore accepted, echoed back and recorded in the
 * audit detail so a sync can be reconciled after the fact, but it is not the
 * key. The cost of content-keying is that two genuinely distinct lapses sharing
 * an enrolment, a microsecond, a severity and a context collapse into one; the
 * client records at most one lapse per deliberate action, so that is not
 * reachable, and collapsing it is the safer of the two failures. Duplicating a
 * lapse would put an event in a person's history that never happened.
 *
 * What this path deliberately does not do: create, pause or end an enrolment,
 * or write sharing consent. Those belong to `enrolment-service`. An item naming
 * an area the caller is not enrolled in is rejected and reported, not
 * accommodated — a sync that could join programmes would let a stale document
 * silently re-join something a person had ended.
 *
 * Nothing here resets anything. `slip_never_resets` is not checked at the end of
 * this function; there is simply no statement in it, or in the store it calls,
 * that lowers a number.
 */

type Rejection = { item: string; key: string; reason: string };

export interface SyncOutcome {
  readonly receipt: SyncReceipt;
  /** True when the batch had already been applied and nothing was written. */
  readonly replayed: boolean;
}

export async function applySync(
  ctx: StoreContext,
  store: RecordStore,
  body: SyncBody,
  idempotencyKey: string,
  now: () => Date = () => new Date(),
): Promise<SyncOutcome> {
  await store.lockSyncBatch(ctx, idempotencyKey);

  const existing = await store.findSyncReceipt(ctx, idempotencyKey);
  if (existing) return { receipt: existing, replayed: true };

  const enrolments = await store.enrolments(ctx);
  const byArea = new Map<string, EnrolmentRow>(
    enrolments.map((enrolment) => [enrolment.areaId, enrolment]),
  );

  const rejected: Rejection[] = [];
  let answersWritten = 0;
  let lapsesCreated = 0;
  let lapsesDuplicate = 0;
  let observationsCreated = 0;
  let observationsDuplicate = 0;

  // -- Answers ---------------------------------------------------------------

  for (const [key, encoded] of Object.entries(body.answers)) {
    const split = splitAnswerKey(key);
    if (!split) {
      rejected.push({
        item: 'answer',
        key,
        // The precise shape of the bug the app was fixed for. A server that
        // accepted it would reintroduce it on the other side of the wire.
        reason: 'answer key names no programme; expected "areaId/screenId"',
      });
      continue;
    }

    const enrolment = byArea.get(split.areaId);
    if (!enrolment) {
      rejected.push({ item: 'answer', key, reason: `not enrolled in ${split.areaId}` });
      continue;
    }

    try {
      const blocks = decodeScreenAnswers(encoded);
      // Merge, not replace. The client sent the screens it has; a screen
      // answered on another device and not yet pulled down is not evidence that
      // the person cleared it.
      const { written } = await store.mergeScreenAnswers(
        ctx,
        enrolment.id,
        split.screenId,
        blocks,
      );
      answersWritten += written;
    } catch (error) {
      if (!isProblem(error)) throw error;
      rejected.push({ item: 'answer', key, reason: error.message });
    }
  }

  // -- Lapses ----------------------------------------------------------------

  for (const lapse of body.lapses) {
    const key = lapse.eventId ?? `${lapse.area}@${lapse.at}`;
    const enrolment = byArea.get(lapse.area);
    if (!enrolment) {
      rejected.push({ item: 'lapse', key, reason: `not enrolled in ${lapse.area}` });
      continue;
    }

    const appended = await store.appendLapse(ctx, enrolment.id, {
      occurredAt: lapse.at,
      severity: lapse.severity,
      // Sorted so that two orderings of the same tags are one event. Without
      // this the content key is order-sensitive and a client that rebuilt its
      // queue would re-insert every lapse it holds.
      context: [...lapse.context].sort(),
    });

    if (appended.created) lapsesCreated += 1;
    else lapsesDuplicate += 1;
  }

  // -- Observations ----------------------------------------------------------

  for (const observation of body.observations) {
    const key = observation.eventId ?? `${observation.area}/${observation.measureId}@${observation.observedAt}`;
    const enrolment = byArea.get(observation.area);
    if (!enrolment) {
      rejected.push({
        item: 'observation',
        key,
        reason: `not enrolled in ${observation.area}`,
      });
      continue;
    }

    const appended = await store.appendObservation(ctx, enrolment.id, {
      measureId: observation.measureId,
      value: observation.value,
      unit: observation.unit,
      observedAt: observation.observedAt,
      source: observation.source,
      platform: observation.platform,
    });

    if (appended.created) observationsCreated += 1;
    else observationsDuplicate += 1;
  }

  const receipt: SyncReceipt = {
    idempotencyKey,
    syncedAt: now().toISOString(),
    applied: {
      answers: answersWritten,
      lapses: lapsesCreated,
      observations: observationsCreated,
    },
    duplicates: { lapses: lapsesDuplicate, observations: observationsDuplicate },
    rejected,
    eventIds: eventIdsIn(body),
  };

  return { receipt, replayed: false };
}

/**
 * The client-supplied item ids a batch carried.
 *
 * Ids only — never a severity, never a note. `ops.audit_event` is a table and
 * gets none of the redaction the logger applies, so what goes in it has to be
 * chosen rather than filtered.
 */
function eventIdsIn(body: SyncBody): string[] {
  const ids: string[] = [];
  for (const lapse of body.lapses) if (lapse.eventId) ids.push(lapse.eventId);
  for (const observation of body.observations) {
    if (observation.eventId) ids.push(observation.eventId);
  }
  return ids;
}
