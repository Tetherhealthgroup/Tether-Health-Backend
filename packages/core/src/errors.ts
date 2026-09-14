/**
 * RFC 7807 Problem Details — the one error shape.
 *
 * The backend this is modelled on had two: a flat `{error: "message"}` in its
 * TypeScript tier and proper problem details in its Go tier. Clients therefore
 * had to branch on which service they happened to be talking to, and the flat
 * shape carried no machine-readable type at all, so nothing downstream could
 * distinguish "you are at the two-programme ceiling" from "that area does not
 * exist" without string-matching English.
 */

/** The stable, machine-readable reasons this API can refuse something. */
export const ProblemType = {
  /** Request body or query failed validation. `errors` lists the fields. */
  validation: 'validation-failed',
  /** No credentials, or credentials that did not verify. */
  unauthenticated: 'unauthenticated',
  /** Authenticated, but not allowed to reach this resource. */
  forbidden: 'forbidden',
  /** The resource does not exist, or the caller may not know that it does. */
  notFound: 'not-found',
  /** The request is well-formed but conflicts with current state. */
  conflict: 'conflict',

  /**
   * `shell.json`'s `two_active_max`: "At most two programs may be active at
   * once. Three concurrent behaviour changes is where adherence collapses. A
   * third requires a conversation with a clinician or coach, not a tap."
   *
   * Its own type because the client has a specific screen for it — the join
   * screen names which programme would be paused and asks the person to
   * choose, rather than the app silently demoting one.
   */
  atProgrammeCeiling: 'at-programme-ceiling',

  /**
   * Nine of the eleven areas are a plan, not an implementation. Joining one is
   * refused rather than accepted-and-ignored.
   */
  areaNotImplemented: 'area-not-implemented',

  /**
   * A read crossed a programme boundary without consent covering it. Separate
   * from `forbidden` because this one is a 42 CFR Part 2 event and is always
   * audited.
   */
  consentRequired: 'consent-required',

  /** Too many requests. */
  rateLimited: 'rate-limited',
  /** Anything unhandled. Never carries detail from the underlying error. */
  internal: 'internal-error',
} as const;

export type ProblemTypeValue = (typeof ProblemType)[keyof typeof ProblemType];

/** One field-level validation failure. */
export interface FieldError {
  readonly path: string;
  readonly message: string;
}

export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance?: string;
  readonly requestId?: string;
  readonly errors?: readonly FieldError[];
  /** RFC 7807 extension members. See [ProblemError.extensions]. */
  readonly [key: string]: unknown;
}

/**
 * Where problem types are documented.
 *
 * A real URL under the API's own origin, resolved at runtime from
 * `PUBLIC_API_URL`. The model repo hard-coded `https://identity.example.com/`
 * into every error it ever returned, which makes the `type` field useless as
 * the dereferenceable identifier RFC 7807 intends it to be.
 */
let problemBase = 'https://api.tetherhealthgroup.com/problems';

export function setProblemBase(url: string): void {
  problemBase = url.replace(/\/+$/, '');
}

/**
 * An error that knows its own HTTP status and problem type.
 *
 * Thrown anywhere; the error middleware turns it into a response. Anything that
 * is *not* one of these becomes a 500 with no detail, because an unplanned
 * error's message is as likely to contain a row of patient data as it is to
 * help.
 */
export class ProblemError extends Error {
  readonly type: ProblemTypeValue;
  readonly status: number;
  readonly fields?: readonly FieldError[];

  /** Extra context for the log only. Never serialised to the client. */
  readonly context?: Readonly<Record<string, unknown>>;

  /**
   * RFC 7807 extension members — serialised into the body.
   *
   * Distinct from [context], and the distinction is the point. Context is for
   * whoever reads the logs; extensions are for the client, and therefore for
   * anyone who can see the response. Putting the two in one bag is how a
   * diagnostic detail ends up on the wire.
   *
   * It exists because conflating them produced a real bug: `wouldPause` was
   * passed as context, so a 409 at the two-programme ceiling could not tell the
   * join screen which programme it would have to pause — and naming that is the
   * whole difference between offering the person a trade and performing one
   * behind their back.
   *
   * Nothing here may be PHI. Every value must be something the caller either
   * sent or is already entitled to see; an area id they are trying to join
   * qualifies, a diagnosis does not.
   */
  readonly extensions?: Readonly<Record<string, unknown>>;

  constructor(
    type: ProblemTypeValue,
    status: number,
    detail: string,
    options: {
      fields?: readonly FieldError[];
      context?: Readonly<Record<string, unknown>>;
      extensions?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    } = {},
  ) {
    super(detail, { cause: options.cause });
    this.name = 'ProblemError';
    this.type = type;
    this.status = status;
    this.fields = options.fields;
    this.context = options.context;
    this.extensions = options.extensions;
  }

  toBody(requestId?: string, instance?: string): ProblemBody {
    return {
      // Extensions first, so a member can never overwrite a reserved field —
      // an `extensions.status` of 200 on a 409 would be worse than useless.
      ...(this.extensions ?? {}),
      type: `${problemBase}/${this.type}`,
      title: this.type,
      status: this.status,
      detail: this.message,
      ...(instance ? { instance } : {}),
      ...(requestId ? { requestId } : {}),
      ...(this.fields?.length ? { errors: this.fields } : {}),
    };
  }
}

export const problem = {
  validation: (detail: string, fields?: readonly FieldError[]) =>
    new ProblemError(ProblemType.validation, 400, detail, { fields }),

  unauthenticated: (detail = 'Valid credentials are required.') =>
    new ProblemError(ProblemType.unauthenticated, 401, detail),

  forbidden: (detail = 'Not permitted.') =>
    new ProblemError(ProblemType.forbidden, 403, detail),

  notFound: (detail = 'Not found.') =>
    new ProblemError(ProblemType.notFound, 404, detail),

  conflict: (detail: string) =>
    new ProblemError(ProblemType.conflict, 409, detail),

  /**
   * [wouldPause] is an extension member, not context, because the client has
   * to render it: `SH3`'s copy is "Joining this would pause Healthy weight",
   * which turns a refusal into a choice the person makes. An area id is not
   * PHI — it is the thing they just asked to join.
   */
  atProgrammeCeiling: (wouldPause: string | null) =>
    new ProblemError(
      ProblemType.atProgrammeCeiling,
      409,
      'Two programmes are already active. Pause one to start another.',
      { extensions: { wouldPause } },
    ),

  areaNotImplemented: (areaId: string) =>
    new ProblemError(
      ProblemType.areaNotImplemented,
      409,
      `The ${areaId} area has no implementation yet, so it cannot be joined.`,
      { context: { areaId } },
    ),

  consentRequired: (detail: string, context?: Record<string, unknown>) =>
    new ProblemError(ProblemType.consentRequired, 403, detail, { context }),

  rateLimited: (detail = 'Too many requests.') =>
    new ProblemError(ProblemType.rateLimited, 429, detail),

  internal: (cause?: unknown) =>
    new ProblemError(
      ProblemType.internal,
      500,
      'The request could not be completed.',
      { cause },
    ),
};

/** True when `value` is one of ours and therefore safe to show a caller. */
export function isProblem(value: unknown): value is ProblemError {
  return value instanceof ProblemError;
}
