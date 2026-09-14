import { z } from 'zod';
import { InstantSchema, SlugSchema, UuidSchema } from './primitives.ts';

/**
 * Joining, pausing, hiding, and per-program sharing consent.
 *
 * Two of the rules in `shell.json` are enforced by the *shape* of what is
 * below, not only by the code that reads it:
 *
 *   per_program_sharing  There is no schema in this file that can express a
 *                        grant without naming a programme. That is the point —
 *                        `programme.sharing_consent` has no `account_id`
 *                        column, and an API that accepted one would be offering
 *                        something the database has deliberately made
 *                        unrepresentable.
 *
 *   two_active_max       The join request carries `pausing`, because refusing
 *                        a third programme is only half a design: the client's
 *                        join screen names which programme would be paused and
 *                        asks the person to choose.
 */

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

export const EnrolmentStatusSchema = z.enum(['active', 'paused', 'ended']);
export type EnrolmentStatus = z.infer<typeof EnrolmentStatusSchema>;

/**
 * What may be seen, and it is two things rather than one.
 *
 * `0003_programme_and_record.sql`: "Totals are not notes: a coach seeing a
 * total is a different disclosure from a coach reading a note." Collapsing
 * these into a single boolean would make the smaller disclosure unavailable,
 * and a person offered only all-or-nothing chooses nothing.
 */
export const SharingScopeSchema = z.enum(['totals_and_adherence', 'notes']);
export type SharingScope = z.infer<typeof SharingScopeSchema>;

export const RecipientKindSchema = z.enum(['coach', 'care_team', 'supporter']);
export type RecipientKind = z.infer<typeof RecipientKindSchema>;

export const SharingConsentSchema = z.object({
  id: UuidSchema,
  enrolmentId: UuidSchema,
  scope: SharingScopeSchema,
  recipientKind: RecipientKindSchema,
  recipientId: z.string().max(128).nullable(),

  /**
   * The words, not only the number.
   *
   * Proving what somebody consented to means keeping what they were shown.
   * A version alone proves only that *a* version existed.
   */
  consentVersion: z.string(),
  consentText: z.string(),

  grantedAt: InstantSchema,

  /**
   * Set on revocation; the row is kept.
   *
   * Revocation is enforced, not merely recorded — `GET /sharing` and the share
   * preview filter on this the moment it is set. The row survives because the
   * history of what was shared and when is the evidence that the revocation
   * was honoured.
   */
  revokedAt: InstantSchema.nullable(),
});
export type SharingConsent = z.infer<typeof SharingConsentSchema>;

export const EnrolmentSchema = z.object({
  id: UuidSchema,
  areaId: SlugSchema,
  status: EnrolmentStatusSchema,

  /**
   * `discreet_program`: hidden from the home screen, reached only from Your
   * programs. Hidden is not paused — a hidden programme still runs, still
   * takes check-ins and still counts against the two-active ceiling. Conflating
   * the two would quietly stop a programme somebody is still doing.
   */
  hidden: z.boolean(),

  /** Set when a child profile, rather than the account holder, is the subject. */
  childProfileId: UuidSchema.nullable(),

  joinedOn: InstantSchema,
  endedAt: InstantSchema.nullable(),

  /** Live grants only. Revoked rows are never returned here. */
  consents: z.array(SharingConsentSchema),
});
export type Enrolment = z.infer<typeof EnrolmentSchema>;

// ---------------------------------------------------------------------------
// POST /enrolments
// ---------------------------------------------------------------------------

export const JoinEnrolmentRequestSchema = z
  .object({
    areaId: SlugSchema,

    /**
     * The programme to pause in order to make room for this one.
     *
     * Optional, and when present it is applied in the same transaction as the
     * join. Two requests would leave a window in which the person has paused
     * something and gained nothing, and if the second failed they would have to
     * discover that for themselves.
     */
    pausing: SlugSchema.optional(),
  })
  .strict();
export type JoinEnrolmentRequest = z.infer<typeof JoinEnrolmentRequestSchema>;

export const EnrolmentResponseSchema = EnrolmentSchema;
export type EnrolmentResponse = z.infer<typeof EnrolmentResponseSchema>;

export const EnrolmentsResponseSchema = z.object({
  enrolments: z.array(EnrolmentSchema),
});
export type EnrolmentsResponse = z.infer<typeof EnrolmentsResponseSchema>;

// ---------------------------------------------------------------------------
// PATCH /enrolments/:areaId
// ---------------------------------------------------------------------------

export const UpdateEnrolmentRequestSchema = z
  .object({
    status: EnrolmentStatusSchema.optional(),
    hidden: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.status !== undefined || value.hidden !== undefined,
    // An empty PATCH is almost always a client bug — a field name that did not
    // survive a rename. Accepting it returns 200 and changes nothing, which is
    // the hardest kind of bug to notice.
    { message: 'Name at least one of status or hidden.' },
  );
export type UpdateEnrolmentRequest = z.infer<typeof UpdateEnrolmentRequestSchema>;

// ---------------------------------------------------------------------------
// PUT /enrolments/:areaId/sharing
// ---------------------------------------------------------------------------

/**
 * Field names that would mean "share everything, everywhere".
 *
 * There is no account-level sharing in this product, so none of these can be
 * honoured — but rejecting them with zod's default "unrecognized key" message
 * teaches a client nothing, and the next attempt is a differently-spelled
 * version of the same idea. Named explicitly, the refusal can quote the rule.
 */
const GLOBAL_GRANT_KEYS = new Set([
  'accountId',
  'account_id',
  'userId',
  'user_id',
  'global',
  'allAreas',
  'allPrograms',
  'allProgrammes',
  'everyProgram',
  'everyProgramme',
  'applyToAll',
  'scopeAll',
]);

const GLOBAL_GRANT_MESSAGE =
  'Sharing consent is granted per program, never globally. A cessation coach ' +
  'has no business seeing behavioural health data, and under 42 CFR Part 2 ' +
  'substance-use data must be segregated regardless. Grant this programme ' +
  'alone, or repeat the request for each programme.';

/**
 * Recipient identifiers that mean "anyone".
 *
 * `recipient_id` is nullable in the schema, and null already means "any
 * recipient of this kind" — which is as wide as a grant is permitted to be.
 * A wildcard string on top of that is a second way to say the same thing, and
 * two ways to say a thing is how one of them escapes review.
 */
const WILDCARD_RECIPIENTS = new Set(['*', 'all', 'any', 'everyone']);

const SharingRequestShape = z.object({
  /**
   * True to grant, false to revoke.
   *
   * One endpoint rather than two because grant and revoke are the same
   * decision in opposite directions, and a person toggling a switch should not
   * be able to land in a state where neither call was made.
   */
  granted: z.boolean(),

  scope: SharingScopeSchema,
  recipientKind: RecipientKindSchema,

  /** Null or absent means "any recipient of this kind". See [WILDCARD_RECIPIENTS]. */
  recipientId: z.string().min(1).max(128).nullish(),

  /** Required when granting — see [SharingConsentSchema.consentText]. */
  consentVersion: z.string().min(1).max(64).optional(),
  consentText: z.string().min(1).max(8_192).optional(),
});

const KNOWN_SHARING_KEYS = new Set(Object.keys(SharingRequestShape.shape));

/**
 * The grant/revoke body.
 *
 * `.passthrough()` rather than `.strict()` deliberately: strict mode rejects an
 * unknown key with a message about JSON, and the interesting rejections here
 * are about consent design rather than about JSON. Unknown keys are still
 * refused below — just with the reason attached.
 */
export const SharingRequestSchema = SharingRequestShape.passthrough().superRefine(
  (value, ctx) => {
    for (const key of Object.keys(value)) {
      if (GLOBAL_GRANT_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: GLOBAL_GRANT_MESSAGE,
        });
      } else if (!KNOWN_SHARING_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Unknown field. A sharing grant names ${[...KNOWN_SHARING_KEYS].join(', ')}.`,
        });
      }
    }

    if (
      typeof value.recipientId === 'string' &&
      WILDCARD_RECIPIENTS.has(value.recipientId.trim().toLowerCase())
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recipientId'],
        message: GLOBAL_GRANT_MESSAGE,
      });
    }

    if (value.granted && (!value.consentVersion || !value.consentText)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consentText'],
        message:
          'A grant must carry the exact wording the person agreed to. ' +
          'Proving what somebody consented to means keeping the words.',
      });
    }
  },
);
export type SharingRequest = z.infer<typeof SharingRequestSchema>;

export const SharingResponseSchema = z.object({
  areaId: SlugSchema,
  enrolmentId: UuidSchema,

  /** Live grants only — revoked rows disappear from here the instant they are revoked. */
  consents: z.array(SharingConsentSchema),
});
export type SharingResponse = z.infer<typeof SharingResponseSchema>;

// ---------------------------------------------------------------------------
// GET /enrolments/:areaId/sharing/preview
// ---------------------------------------------------------------------------

/**
 * `GET …/sharing/preview?scope=&recipientKind=`
 *
 * With no parameters the preview covers every live consent. With both, it
 * previews a grant that has not been made yet — which is the case the
 * `share_on_request_only` safeguard is actually about: "Readings and history go
 * to a clinician only when the person chooses, **after previewing what is
 * sent**."
 */
export const SharePreviewQuerySchema = z
  .object({
    scope: SharingScopeSchema.optional(),
    recipientKind: RecipientKindSchema.optional(),
  })
  .strip()
  .refine(
    (value) =>
      (value.scope === undefined) === (value.recipientKind === undefined),
    {
      message:
        'Give both scope and recipientKind to preview a prospective grant, or ' +
        'neither to preview the grants already live.',
    },
  );
export type SharePreviewQuery = z.infer<typeof SharePreviewQuerySchema>;

export const SharePreviewTotalSchema = z.object({
  measureId: SlugSchema,
  label: z.string(),
  unit: z.string(),
  count: z.number().int().nonnegative(),
  firstObservedAt: InstantSchema.nullable(),
  lastObservedAt: InstantSchema.nullable(),
  latestValue: z.union([z.number(), z.string()]).nullable(),
});
export type SharePreviewTotal = z.infer<typeof SharePreviewTotalSchema>;

export const SharePreviewNoteSchema = z.object({
  screenId: z.string(),
  blockIndex: z.number().int().nonnegative(),
  text: z.string(),
  answeredAt: InstantSchema,
});
export type SharePreviewNote = z.infer<typeof SharePreviewNoteSchema>;

export const SharePreviewPayloadSchema = z.object({
  programme: z.object({
    areaId: SlugSchema,
    areaName: z.string(),
    status: EnrolmentStatusSchema,
    joinedOn: InstantSchema,
  }),
  totals: z.array(SharePreviewTotalSchema),
  adherence: z.object({
    answersRecorded: z.number().int().nonnegative(),
    lapsesRecorded: z.number().int().nonnegative(),

    /**
     * Dates only, never severity or context, under `totals_and_adherence`.
     * `slip_never_resets` makes a lapse a history entry rather than a penalty;
     * handing a coach the person's description of it is the other disclosure.
     */
    lapseDates: z.array(InstantSchema),
  }),

  /**
   * Null unless the scope is `notes` — and null is the honest rendering of
   * "this recipient would receive none of your own words", which is precisely
   * what the person is being asked to check.
   */
  notes: z.array(SharePreviewNoteSchema).nullable(),
});
export type SharePreviewPayload = z.infer<typeof SharePreviewPayloadSchema>;

export const SharePreviewEntrySchema = z.object({
  /** Null when this is a prospective grant rather than a live one. */
  consentId: UuidSchema.nullable(),
  prospective: z.boolean(),
  scope: SharingScopeSchema,
  recipientKind: RecipientKindSchema,
  recipientId: z.string().nullable(),
  payload: SharePreviewPayloadSchema,
});
export type SharePreviewEntry = z.infer<typeof SharePreviewEntrySchema>;

export const SharePreviewResponseSchema = z.object({
  areaId: SlugSchema,
  generatedAt: InstantSchema,

  /**
   * Always true, and serialised rather than assumed.
   *
   * This endpoint sends nothing to anybody. It exists so a person can read what
   * a recipient would get before deciding, and a client that treated it as the
   * act of sharing would turn a safeguard into a disclosure.
   */
  nothingWasSent: z.literal(true),

  entries: z.array(SharePreviewEntrySchema),
});
export type SharePreviewResponse = z.infer<typeof SharePreviewResponseSchema>;
