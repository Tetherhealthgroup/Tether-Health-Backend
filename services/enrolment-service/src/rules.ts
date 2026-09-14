import { problem, ProblemError } from '@tether/core';
import type { SharingConsent } from '@tether/contracts';

/**
 * The rules, separated from the SQL that feeds them.
 *
 * Everything in this file is a pure function over plain data. That is
 * deliberate: `two_active_max` and `per_program_sharing` are the two promises
 * this service exists to keep, the website has already published them —
 * "Consent versioning, purpose limitation and revocation enforced on the
 * server, not merely reflected in the interface" (`security.astro`) — and a
 * promise that can only be exercised by standing up Postgres is a promise
 * nobody exercises. `test/` calls these directly.
 */

/**
 * The ceiling when the catalogue cannot supply one.
 *
 * `shell.json`'s rule reads "At most two programs may be active at once." — in
 * words, with no digit in it. Both the database trigger
 * (`substring(rule from '\d+')::int`) and [ceilingFromRule] below therefore
 * extract nothing from the shipped text and fall back to this constant. That
 * they fall back to the *same* constant is the part that matters: an API and a
 * trigger that disagreed about the ceiling would produce a 500 on exactly the
 * request the friendly refusal was written for.
 */
export const DEFAULT_ACTIVE_CEILING = 2;

/**
 * Reads the ceiling out of the shell rule, the way the trigger does.
 *
 * Parsed from the rule text rather than hard-coded so the number lives in one
 * place — the catalogue — and changing it is a seed, not a deploy.
 */
export function ceilingFromRule(ruleText: string | null | undefined): number {
  const digits = ruleText?.match(/\d+/)?.[0];
  if (digits === undefined) return DEFAULT_ACTIVE_CEILING;

  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ACTIVE_CEILING;
}

/** An active programme, reduced to what the ceiling rule needs. */
export interface ActiveProgramme {
  readonly areaId: string;
  /** First join. Not reset by a pause and resume — see [longestRunning]. */
  readonly joinedOn: string;
}

/**
 * The programme that would be paused to make room for another.
 *
 * The longest-running one, by `joined_on`. `joined_on` is set at the first join
 * and is not touched by a pause and resume, so "longest-running" means "the one
 * you have been doing longest", not "the one that has been active continuously
 * longest" — which is the one a person recognises when the join screen names
 * it. Returns null only when nothing is active, in which case nothing is being
 * refused anyway.
 */
export function longestRunning(
  active: readonly ActiveProgramme[],
): string | null {
  let oldest: ActiveProgramme | null = null;
  for (const programme of active) {
    if (oldest === null || programme.joinedOn < oldest.joinedOn) {
      oldest = programme;
    }
  }
  return oldest?.areaId ?? null;
}

export interface CeilingCheck {
  /** Programmes that would be active if the request were honoured. */
  readonly remaining: readonly ActiveProgramme[];
  /** True when the request must be refused. */
  readonly refused: boolean;
  /** Named in the refusal. Null when nothing is being refused. */
  readonly wouldPause: string | null;
}

/**
 * Decides whether activating `areaId` is allowed, given what is active now.
 *
 * Three cases, and the order they are handled in is the order the rule is
 * written in:
 *
 *  - `areaId` is already active. Nothing changes and nothing is refused;
 *    re-joining something you are already doing must not be read as a third
 *    programme.
 *  - `pausing` names an active programme. It comes out of the count, because
 *    the pause and the join happen in one transaction — see the route.
 *  - Otherwise the remaining count is compared against the ceiling.
 */
export function checkCeiling(input: {
  readonly active: readonly ActiveProgramme[];
  readonly areaId: string;
  readonly pausing?: string | undefined;
  readonly ceiling: number;
}): CeilingCheck {
  const { active, areaId, pausing, ceiling } = input;

  const alreadyActive = active.some(
    (programme) => programme.areaId === areaId,
  );

  const remaining = active.filter(
    (programme) => programme.areaId !== pausing && programme.areaId !== areaId,
  );

  if (alreadyActive) {
    return { remaining, refused: false, wouldPause: null };
  }

  // `remaining` excludes the programme being joined, so the comparison is
  // "would there be room for one more", not "are there already too many".
  const refused = remaining.length >= ceiling;

  return {
    remaining,
    refused,
    wouldPause: refused ? longestRunning(remaining) : null,
  };
}

/** The friendly refusal, naming what the person would have to give up. */
export function ceilingRefusal(check: CeilingCheck): ProblemError {
  return problem.atProgrammeCeiling(check.wouldPause);
}

// ---------------------------------------------------------------------------
// Translating the database's backstop into the API's refusal
// ---------------------------------------------------------------------------

/** The `check_violation` SQLSTATE the constraint trigger raises. */
const CHECK_VIOLATION = '23514';

/** Enough of `pg`'s error to recognise one. `pg` does not export a type for it. */
interface PostgresErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly where?: unknown;
  readonly message?: unknown;
}

/**
 * True when this error is the `two_active_max` trigger firing.
 *
 * The API checks the ceiling before it writes, and the API is not enough: two
 * concurrent joins each read one active programme and each write a second, so
 * `0003_programme_and_record.sql` carries a deferred constraint trigger as the
 * real enforcement. Deferred means it fires at COMMIT — *outside* the callback
 * passed to `withPrincipal`, in the `COMMIT` statement itself — which is why
 * the translation below has to wrap the whole `withPrincipal` call rather than
 * the insert.
 *
 * Recognised by two independent signals because neither alone is sound:
 *
 *  - SQLSTATE `23514` is shared with every ordinary CHECK on these tables
 *    (`status IN ('active','paused','ended')`, `scope IN (…)`), so the code by
 *    itself would turn a malformed status into a ceiling message.
 *  - The trigger raises with `USING ERRCODE = 'check_violation'` and no
 *    constraint name, so `error.constraint` is absent where a real CHECK would
 *    set it — and `error.where` carries the plpgsql context naming the
 *    function.
 *
 * The message match is the fallback for a driver or server version that does
 * not populate `where`. Matching on English is unpleasant; letting a 23514
 * escape as a 500 on the one path the product wrote a bespoke error screen for
 * is worse.
 */
export function isActiveCeilingViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as PostgresErrorLike;
  if (candidate.code !== CHECK_VIOLATION) return false;
  if (typeof candidate.constraint === 'string') return false;

  const where = typeof candidate.where === 'string' ? candidate.where : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';

  return (
    where.includes('enforce_active_ceiling') ||
    /may be active at once/i.test(message)
  );
}

/**
 * Runs `work`, turning the trigger's `23514` into `at-programme-ceiling`.
 *
 * `hint` is filled in by `work` while it still has a transaction to read from,
 * because by the time the deferred trigger fires at COMMIT there is no usable
 * transaction left to ask "which programme is oldest". In the race this exists
 * for — two joins committing at once — the hint is the loser's own pre-check
 * snapshot, which names a programme that really was active a moment ago. That
 * is the right answer to show a person, and it is the only answer available.
 */
export async function withCeilingTranslation<T>(
  hint: { wouldPause: string | null },
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isActiveCeilingViolation(error)) {
      throw problem.atProgrammeCeiling(hint.wouldPause);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// per_program_sharing
// ---------------------------------------------------------------------------

/**
 * The single definition of "this consent is live".
 *
 * One definition, used by `GET /sharing`, by `GET /enrolments` and by the share
 * preview, rather than a `revoked_at IS NULL` repeated in three queries.
 * Revocation here is enforced, not recorded: the moment `revoked_at` is set the
 * grant must stop appearing everywhere, and three copies of the predicate is
 * three chances for one of them to be the copy somebody forgot. The rows
 * themselves are kept — the history of what was shared and when is the evidence
 * that the revocation was honoured.
 */
export function liveConsents(
  consents: readonly SharingConsent[],
): SharingConsent[] {
  return consents.filter((consent) => consent.revokedAt === null);
}
