import { z } from 'zod';

/**
 * The auth service's own environment.
 *
 * This service sits between two issuers and is the only place in the system
 * that knows both. Supabase Auth is upstream: the Flutter apps and the Astro
 * site sign in with the Supabase SDK, so a user arrives here holding a Supabase
 * access token. Tether is downstream: nothing else in this backend trusts
 * Supabase, and every other service verifies a token this service minted.
 *
 * Keeping the two sets of variables visibly separate below is the point. The
 * moment a `SUPABASE_*` value is used to verify a Tether token, or the reverse,
 * the boundary this service exists to draw has gone.
 */

/**
 * A PEM key read from the environment.
 *
 * Environment variables are single-line in most of the places that set them —
 * Compose files, CI secrets, systemd units — so a literal `\n` is accepted and
 * unescaped. The alternative, base64, hides a malformed key until the first
 * signature; this way the shape is checked at boot, where a bad key is a failed
 * deploy rather than a 500 on somebody's sign-in.
 */
const pem = z
  .string()
  .min(1)
  .transform((value) => value.replace(/\\n/g, '\n').trim())
  .refine((value) => value.startsWith('-----BEGIN'), {
    message: 'must be a PEM block beginning with -----BEGIN',
  });

export const authSchema = z.object({
  // -------------------------------------------------------------------------
  // Upstream: Supabase Auth
  // -------------------------------------------------------------------------

  SUPABASE_JWKS_URL: z.string().url(),
  SUPABASE_ISSUER: z.string().url(),

  /**
   * Supabase stamps `aud: "authenticated"` on a signed-in user's token.
   *
   * Asserted rather than ignored, for the reason `@tether/core`'s `config.ts`
   * gives: a correctly-signed token minted for a different audience in the same
   * project is a valid signature and the wrong caller.
   */
  SUPABASE_AUDIENCE: z.string().min(1).default('authenticated'),

  /**
   * One algorithm, named explicitly.
   *
   * Supabase's asymmetric signing keys are P-256 (`ES256`) by default, with RSA
   * available. Which one a project uses is a property of that project, so it is
   * configuration — but it is configuration with exactly one value at a time.
   * Accepting both would be the algorithm-confusion hole `@tether/core`'s
   * `auth.ts` was written to close, reopened here.
   */
  SUPABASE_JWT_ALGORITHM: z.enum(['RS256', 'ES256']).default('ES256'),

  // -------------------------------------------------------------------------
  // Downstream: Tether's own tokens
  // -------------------------------------------------------------------------

  /** Signs access tokens. Never leaves this service. */
  ACCESS_TOKEN_PRIVATE_KEY: pem,

  /**
   * Published at `/.well-known/jwks.json`, and nothing else.
   *
   * Configured separately rather than derived from the private key so that the
   * two can be rotated as a pair by the deployment, and so that this service
   * can be given only the public half in any future setup where signing moves
   * to a KMS.
   */
  ACCESS_TOKEN_PUBLIC_KEY: pem,

  /**
   * The `kid` in the JWT header and in the published JWKS.
   *
   * Optional, and defaulted to the key's RFC 7638 thumbprint when absent. A
   * hand-chosen `kid` is one more string that can be set on one side of a
   * rotation and not the other; a thumbprint cannot disagree with its own key.
   */
  ACCESS_TOKEN_KID: z.string().min(1).optional(),

  /**
   * Fifteen minutes.
   *
   * Short because an access token cannot be revoked — there is no lookup on the
   * verification path, by design, or every service would need this service to
   * be up to answer a request. Its lifetime *is* its revocation window, so the
   * ceiling below is a hard limit rather than advice: an hour-long access token
   * means an hour during which `DELETE /sessions` has no observable effect.
   */
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(3_600)
    .default(900),

  /**
   * Thirty days, and rotated on every use.
   *
   * The long lifetime is what keeps a patient from being signed out of a
   * cessation programme mid-week; rotation plus family reuse detection is what
   * makes a long lifetime survivable. One without the other is either a bad
   * experience or a bad risk.
   */
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
});

export type AuthConfig = z.infer<typeof authSchema>;
