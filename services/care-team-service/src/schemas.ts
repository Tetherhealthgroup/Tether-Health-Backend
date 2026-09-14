import { z } from 'zod';

/**
 * Request shapes for the clinician surface.
 *
 * Small, because this service reads far more than it writes. The one write is
 * an escalation, and what it may say is bounded on purpose: `signal` names an
 * observation, `detail` describes it, and there is deliberately no field for a
 * score, a grade, a severity number or a risk band. `no_risk_score` forbids a
 * `risk_percentage` and a `risk_grade`; the cheapest way to honour that is for
 * the API to have nowhere to put one.
 */

export const escalationSchema = z
  .object({
    enrolmentId: z.string().uuid(),
    /**
     * What was observed, named.
     *
     * Free-form rather than an enum because the vocabulary belongs to clinical
     * leadership and lives in `care.escalation_policy`'s world, not in a zod
     * schema that would need a deploy to extend. Bounded, so the column holds
     * a label rather than a case note — the case note is `detail`.
     */
    signal: z.string().min(1).max(120),
    detail: z.string().max(4_000).nullable().default(null),
  })
  .strict();

export type EscalationBody = z.infer<typeof escalationSchema>;
