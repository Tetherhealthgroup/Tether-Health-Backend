import { z } from 'zod';
import { KINDS, variablesFor, isKind } from './content.ts';

/**
 * The request shapes — and, more importantly, the shapes that are not here.
 *
 * `POST /send` has no `title` and no `body`. That absence is the first of the
 * four mechanisms described at the top of `content.ts`: there is no string a
 * caller can put in a request that becomes displayed text on a device.
 *
 * Every schema below is `.strict()`. Zod's default is to drop unknown keys
 * silently, which would mean a service posting `{ …, body: 'Naltrexone due' }`
 * got a 200 and no notification text — working code by accident, and one
 * refactor away from working code that sends it. Strict turns that into a 400
 * naming the field, which is a bug report rather than a latent disclosure.
 */

/**
 * An FCM registration token is ~160 characters today and has grown before, so
 * the ceiling is generous. It is bounded at all only because an unbounded
 * string is an unbounded index entry.
 */
export const deviceRegistrationSchema = z
  .object({
    token: z.string().trim().min(16).max(4_096),

    // The three platforms `ops.device_token` accepts. Checked here so a typo
    // is a 400 naming the field rather than a 23514 from Postgres surfacing as
    // a 500.
    platform: z.enum(['ios', 'android', 'web']),

    /**
     * Which health area the device registered for. Optional: the app registers
     * its token at launch, long before anybody has chosen an area.
     */
    areaId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type DeviceRegistrationInput = z.infer<typeof deviceRegistrationSchema>;

/**
 * Template variable values.
 *
 * Short, because they are substituted into a lock-screen line and a paragraph
 * would be truncated by the OS anyway — and because a generous limit here would
 * make `vars` the free-text channel that the missing `body` field exists to
 * prevent. Which keys are permitted is decided per kind, below.
 */
const variableValue = z.string().trim().max(64);

export const sendSchema = z
  .object({
    /** Who to send to. A uuid, matching `identity.account.id`. */
    accountId: z.string().uuid(),

    /** Which template. Not free text; see `content.ts`. */
    kind: z.enum(KINDS),

    /**
     * An opaque identifier the app uses to fetch the real content after
     * unlock — a medication id, a message id. It travels in the FCM `data`
     * block, which the OS hands to the app rather than displaying.
     */
    refId: z.string().trim().min(1).max(128).optional(),

    /**
     * Values for the template, used only when the account has opted in.
     *
     * Present in the schema even though most calls omit them, because the
     * alternative — a second endpoint for specific sends — would be a second
     * endpoint somebody could call without the preference check.
     */
    vars: z.record(z.string(), variableValue).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!isKind(value.kind)) return;
    const allowed = variablesFor(value.kind);
    for (const key of Object.keys(value.vars ?? {})) {
      if (!allowed.includes(key)) {
        // Naming the permitted set rather than just refusing: the caller is
        // another service, and the person debugging it deserves to be told
        // what the template actually takes.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vars', key],
          message:
            `The ${value.kind} template has no variable called "${key}". ` +
            `It accepts: ${allowed.length > 0 ? allowed.join(', ') : '(none)'}.`,
        });
      }
    }
  });

export type SendInput = z.infer<typeof sendSchema>;

/**
 * The opt-in.
 *
 * `consentText` is required to turn it on. The database requires it too
 * (`notification_preference_optin_is_evidenced`), and it is checked in both
 * places on purpose: the constraint is what makes it true of the data, and this
 * is what makes the failure a 400 with a field name instead of a 500.
 *
 * What goes in it is the exact wording the person was shown — "Show medication
 * and check-in details on my lock screen" — not a version number. Proving what
 * somebody agreed to means keeping the words, which is the same decision
 * `programme.sharing_consent` makes in `0003`.
 */
export const preferenceSchema = z
  .object({
    specificContent: z.boolean(),
    consentText: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .refine((value) => !value.specificContent || Boolean(value.consentText), {
    path: ['consentText'],
    message:
      'Turning on detailed notifications needs the wording the person agreed ' +
      'to, so that the consent can be produced later.',
  });

export type PreferenceInput = z.infer<typeof preferenceSchema>;
