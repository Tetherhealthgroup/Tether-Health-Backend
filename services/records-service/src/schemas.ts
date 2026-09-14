import { z } from 'zod';
import { encodedScreenAnswersSchema } from './answers.ts';

/**
 * Request shapes.
 *
 * Every one of these is derived from something the Flutter app already emits,
 * not invented here. `LapseEvent` has exactly `at`, `severity` and `context`;
 * `TetherSession.toJson()` has exactly `version`, `enrolments`, `answers` and
 * `lapses`. Where the field names differ below it is because the HTTP surface
 * spells them out (`occurredAt` for `at`), and `POST /sync` accepts both.
 *
 * Validation is zod rather than hand-written checks for the reason
 * ARCHITECTURE.md gives: the repo this is modelled on had roughly fifty bespoke
 * 400 messages, and one shape that lists every failing field at once is both
 * kinder to a client and the thing the OpenAPI can be generated from.
 */

/**
 * An instant the client is sure of.
 *
 * `datetime({offset: true})` so a bare `2026-01-01T09:00:00` is refused. A
 * local time with no zone is the field most likely to be off by a working day,
 * and `occurred_at` on a lapse is evidence about when something happened to a
 * person, not a display string. Dart's `toIso8601String()` on a UTC `DateTime`
 * emits the `Z`, so the app already satisfies this.
 */
const instant = z.string().datetime({ offset: true });

/**
 * `severity` is the person's own description, chosen from the lapse screen's
 * options — so it is short, and free text only in the sense that the client
 * decides the vocabulary. Bounded rather than unbounded because an unbounded
 * string is a storage decision made by whoever calls the endpoint.
 */
export const lapseSchema = z
  .object({
    occurredAt: instant,
    severity: z.string().min(1).max(200),
    context: z.array(z.string().min(1).max(120)).max(50).default([]),
  })
  .strict();

export type LapseBody = z.infer<typeof lapseSchema>;

export const observationSchema = z
  .object({
    measureId: z.string().min(1).max(120),
    /**
     * Number or string, because `record.observation` has `value_num` and
     * `value_text` and requires exactly one. Which one is decided by the type
     * of what arrives, not by a flag the caller could set inconsistently.
     */
    value: z.union([z.number().finite(), z.string().min(1).max(2_000)]),
    unit: z.string().min(1).max(60),
    observedAt: instant,
    /**
     * `self_report_only`: "Ratings describe how someone felt. The product is
     * explicit that these are self-reports." So `source` has no default that
     * would let a self-report be stored as anything else by omission — the
     * column's default is `self_report`, and this makes the caller say it.
     */
    source: z.enum(['self_report', 'device', 'clinician', 'derived']),
    /**
     * The addendum's risk register asks for platform "on every patient record":
     * iOS reports aggregate screen time where Android reports per-app, so the
     * same measure means different things depending on where it came from.
     */
    platform: z.enum(['ios', 'android', 'web', 'unknown']).nullable().default(null),
  })
  .strict();

export type ObservationBody = z.infer<typeof observationSchema>;

/** `PUT /:areaId/answers/:screenId` — the block map for that one screen. */
export const screenAnswersSchema = encodedScreenAnswersSchema;

/**
 * One lapse inside a sync document, in the app's own spelling.
 *
 * `area` and `at` are what `toJson()` writes. `eventId` is accepted, echoed
 * back and recorded in the audit detail, but it is deliberately *not* the
 * deduplication key — see `sync.ts`.
 */
const syncLapseSchema = z
  .object({
    area: z.string().min(1).max(120),
    at: instant,
    severity: z.string().max(200).default(''),
    context: z.array(z.string().min(1).max(120)).max(50).default([]),
    eventId: z.string().min(1).max(200).optional(),
  })
  .strict();

const syncObservationSchema = observationSchema
  .extend({
    area: z.string().min(1).max(120),
    eventId: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * One enrolment inside a sync document.
 *
 * Read, never written. Joining, pausing and sharing consent belong to
 * `enrolment-service`; this service would be a second writer of the same rows
 * and the two would disagree the first time a sync arrived out of order. It is
 * parsed only so that a document carrying it is not rejected, and so the
 * receipt can say which programmes the batch claimed to be about.
 */
const syncEnrolmentSchema = z
  .object({
    area: z.string().min(1).max(120),
    status: z.string().max(40).optional(),
    hidden: z.boolean().optional(),
    joinedOn: z.string().nullable().optional(),
    sharing: z.unknown().optional(),
  })
  .passthrough();

/**
 * The whole document `TetherSession.toJson()` produces, plus a batch key.
 *
 * `version` is pinned to 2 and a mismatch is refused rather than migrated. The
 * app's `restoreFrom` takes exactly this position and explains it best: a
 * version 1 document keys answers by screen id alone, `behavioral` and
 * `digital` both resolve to the `lookup` product, and "a migration would have
 * to guess, and the wrong guess files a person's answers under a programme they
 * were never given in". Losing an old snapshot costs a person their answers;
 * guessing costs them the segregation 42 CFR Part 2 requires, silently. A
 * server has even less standing to guess than the client that wrote it.
 */
export const SYNC_SCHEMA_VERSION = 2;

export const syncSchema = z
  .object({
    version: z.literal(SYNC_SCHEMA_VERSION),
    /**
     * The client's name for this batch. May also arrive as `Idempotency-Key`.
     *
     * Required, with no server-side fallback. A key the server invented would
     * be different on every retry, which is exactly the property that makes it
     * useless: `PRODUCTION_RELEASE_CHECKLIST.md` asks that "offline actions
     * synchronize once without duplication", and only the client knows that two
     * requests are one action.
     */
    idempotencyKey: z.string().min(8).max(200).optional(),
    enrolments: z.array(syncEnrolmentSchema).max(50).default([]),
    /** Keyed `areaId/screenId`, per `TetherSession._answerKey`. */
    answers: z.record(z.string(), encodedScreenAnswersSchema).default({}),
    lapses: z.array(syncLapseSchema).max(1_000).default([]),
    /** Not written by the app today; accepted so the document can grow. */
    observations: z.array(syncObservationSchema).max(1_000).default([]),
  })
  .strict();

export type SyncBody = z.infer<typeof syncSchema>;

/** `GET /export?locale=` — the locale is the app's, not the server's. */
export const exportQuerySchema = z
  .object({
    locale: z.string().min(2).max(35).default('en'),
  })
  .passthrough();
