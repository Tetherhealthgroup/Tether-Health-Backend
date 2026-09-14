import type { Transaction } from '@tether/core';

/**
 * Every statement this service runs. `0006_notifications.sql` is the schema.
 *
 * All of it executes inside `withPrincipal(accountId)`, including the internal
 * `POST /send` path — the service is acting *for* the recipient when it reads
 * their devices, so RLS applies there exactly as it does to a request the
 * person made themselves. A bug that loses track of whose notification is being
 * sent returns zero devices instead of somebody else's.
 */

export interface DeviceRegistration {
  readonly token: string;
  readonly platform: 'ios' | 'android' | 'web';
  readonly areaId: string | null;
}

type DeviceRow = { id: string; created_at: Date; last_seen_at: Date };

/**
 * Registers a device, or refreshes the registration that is already there.
 *
 * `ON CONFLICT (token)` rather than `(account_id, token)`: the token is the
 * device. A phone handed to somebody else, or an account switched inside the
 * app, keeps the same FCM token, and a per-account upsert would leave the old
 * row in place and push to both people. Re-registering transfers ownership,
 * which is the only outcome that is not a disclosure.
 */
export async function registerDevice(
  tx: Transaction,
  accountId: string,
  device: DeviceRegistration,
): Promise<{ id: string; createdAt: Date }> {
  const rows = await tx.query<DeviceRow>(
    `
    INSERT INTO ops.device_token (account_id, token, platform, area_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (token) DO UPDATE
       SET account_id   = EXCLUDED.account_id,
           platform     = EXCLUDED.platform,
           area_id      = EXCLUDED.area_id,
           last_seen_at = now()
    RETURNING id, created_at, last_seen_at
    `,
    [accountId, device.token, device.platform, device.areaId],
  );

  const row = rows[0];
  if (!row) throw new Error('device registration returned no row');
  return { id: row.id, createdAt: row.created_at };
}

/**
 * Removes one device. Returns whether a row went.
 *
 * Scoped to the account as well as the token, and RLS scopes it again. The
 * belt-and-braces is cheap and the failure it prevents is somebody unregistering
 * another person's phone by quoting a token they saw in a log — which is also
 * why a token never appears in one.
 */
export async function removeDevice(
  tx: Transaction,
  accountId: string,
  token: string,
): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    'DELETE FROM ops.device_token WHERE account_id = $1 AND token = $2 RETURNING id',
    [accountId, token],
  );
  return rows.length > 0;
}

/** The account's live device tokens, newest registration first. */
export async function tokensFor(
  tx: Transaction,
  accountId: string,
): Promise<string[]> {
  const rows = await tx.query<{ token: string }>(
    `SELECT token FROM ops.device_token
      WHERE account_id = $1
      ORDER BY last_seen_at DESC`,
    [accountId],
  );
  return rows.map((row) => row.token);
}

/**
 * Deletes tokens FCM has told us are dead.
 *
 * Done in the same transaction as the send that discovered them. A separate
 * cleanup job would need its own schedule and its own way of knowing, and the
 * information is already here.
 */
export async function pruneTokens(
  tx: Transaction,
  accountId: string,
  tokens: readonly string[],
): Promise<number> {
  if (tokens.length === 0) return 0;
  const rows = await tx.query<{ id: string }>(
    `DELETE FROM ops.device_token
      WHERE account_id = $1 AND token = ANY($2::text[])
      RETURNING id`,
    [accountId, [...tokens]],
  );
  return rows.length;
}

export interface Preference {
  readonly specificContent: boolean;
  readonly optedInAt: Date | null;
}

/**
 * The account's preference, defaulted off when there is no row.
 *
 * `defaultOff: true` is in the column default and here as well, because "no row
 * yet" is a state the column default cannot speak for. Reading absence as off
 * is what makes forgetting to create a row on signup harmless.
 */
export async function readPreference(
  tx: Transaction,
  accountId: string,
): Promise<Preference> {
  const row = await tx.one<{ specific_content: boolean; opted_in_at: Date | null }>(
    `SELECT specific_content, opted_in_at
       FROM ops.notification_preference
      WHERE account_id = $1`,
    [accountId],
  );
  return {
    specificContent: row?.specific_content ?? false,
    optedInAt: row?.opted_in_at ?? null,
  };
}

/**
 * Turns the specific-content opt-in on or off.
 *
 * Turning it *on* requires the wording the person was shown, and the database
 * enforces that too (`notification_preference_optin_is_evidenced`). The
 * security page already promises "consent versioning, purpose limitation and
 * revocation enforced on the server, not merely reflected in the interface" —
 * an opt-in stored as a bare boolean could not support any of the three.
 *
 * Turning it *off* clears the timestamp and the wording. Keeping them would
 * leave a record that reads like a live consent to anything that checked only
 * `opted_in_at`, and revocation has to be the state that wins.
 */
export async function setPreference(
  tx: Transaction,
  accountId: string,
  specificContent: boolean,
  consentText: string | null,
): Promise<Preference> {
  const rows = await tx.query<{ specific_content: boolean; opted_in_at: Date | null }>(
    `
    INSERT INTO ops.notification_preference
      (account_id, specific_content, opted_in_at, consent_text)
    VALUES ($1, $2,
            CASE WHEN $2 THEN now() ELSE NULL END,
            CASE WHEN $2 THEN $3 ELSE NULL END)
    ON CONFLICT (account_id) DO UPDATE
       SET specific_content = EXCLUDED.specific_content,
           opted_in_at      = EXCLUDED.opted_in_at,
           consent_text     = EXCLUDED.consent_text
    RETURNING specific_content, opted_in_at
    `,
    [accountId, specificContent, consentText],
  );

  const row = rows[0];
  if (!row) throw new Error('preference upsert returned no row');
  return { specificContent: row.specific_content, optedInAt: row.opted_in_at };
}

/**
 * The delivery record.
 *
 * Exported as a string so a test can assert what is *not* in it. The absence of
 * a body column is the point of `ops.notification_log`, and an absence is the
 * one property that rots without something watching it — the next person to add
 * a column here should have to delete a test that says why they should not.
 */
export const NOTIFICATION_LOG_SQL = `
  INSERT INTO ops.notification_log
    (account_id, kind, variant, device_count, delivered_count, failed_count, provider)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
`;

export interface DeliveryRecord {
  readonly accountId: string;
  readonly kind: string;
  readonly variant: 'generic' | 'specific';
  readonly deviceCount: number;
  readonly delivered: number;
  readonly failed: number;
  readonly provider: string;
}

/**
 * Writes what was sent, when, and to whom — never what it said.
 *
 * There is no parameter here for the text and no column to put it in. That is
 * deliberate and it is the same reasoning as the redaction list in
 * `packages/core/src/logger.ts`: the cheapest way never to disclose something
 * is never to have written it down.
 */
export async function recordDelivery(
  tx: Transaction,
  record: DeliveryRecord,
): Promise<void> {
  await tx.query(NOTIFICATION_LOG_SQL, [
    record.accountId,
    record.kind,
    record.variant,
    record.deviceCount,
    record.delivered,
    record.failed,
    record.provider,
  ]);
}
