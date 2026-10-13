-- 0011 · Least-privilege grants, one service at a time.
--
-- Derived from the SQL each service actually runs, not from what it might one
-- day want. Each block names the file that issues the statement, so that
-- changing a query and changing its grant are one review rather than two.
-- `db/ROLES.md` carries the same matrix in a table.
--
-- Three rules hold throughout:
--
--   * Verbs are the ones the code uses. A service that only reads a table gets
--     SELECT and nothing else.
--   * INSERT and UPDATE are granted by column where the statements name their
--     columns, so a service cannot write a column it has no reason to touch
--     (`owner_account_id`, `raised_by` of another account, `consent_text` after
--     the fact).
--   * Where a policy's subquery reads another table, the role needs SELECT on
--     the columns that policy reads. PostgreSQL checks the privileges of the
--     caller for a policy's subqueries, so a missing one shows up as a
--     permission error on a table the service never mentions. The "policy"
--     lines below are those.
--
-- Identity columns (`ops.audit_event.id`, `ops.notification_log.id`) need no
-- sequence grant: PostgreSQL advances an identity sequence without checking the
-- inserting role's privileges on it.
--
-- Nothing here grants a role to another role, grants on a schema's `CREATE`, or
-- grants anything WITH GRANT OPTION.

-- ---------------------------------------------------------------------------
-- auth-service — identity, and the proof of a deletion
-- ---------------------------------------------------------------------------

-- 0004 already granted tether_auth its privileges, and its header is the
-- argument for them. Re-stated rather than assumed, because a later edit to
-- 0004's grants must not silently widen or narrow this role.
GRANT USAGE ON SCHEMA identity, ops TO tether_auth;

-- accounts.ts:70  INSERT … ON CONFLICT (external_id) DO UPDATE (sign-in upsert)
-- accounts.ts:114 SELECT by id (GET /me)
-- accounts.ts:165 SELECT … FOR UPDATE, then accounts.ts:196 DELETE (DELETE /me)
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.account TO tether_auth;
-- store.ts:64 SELECT … FOR UPDATE, store.ts:75 INSERT, store.ts:100,109,120 UPDATE
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.refresh_session TO tether_auth;
-- accounts.ts:179 INSERT only. The audit row outlives the account it describes.
GRANT INSERT ON ops.audit_event TO tether_auth;

-- ---------------------------------------------------------------------------
-- catalogue-service — read-only, and non-PHI
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA catalogue TO tether_catalogue;

-- repository.ts:238-446 reads each of these and writes none. 0002 says the
-- catalogue is "writable only by the catalogue service", but the service has no
-- write path: the bundle is loaded by `db/seeds/catalogue.ts` under the
-- migration role. So this role does not get one.
GRANT SELECT ON
  catalogue.area, catalogue.service_line, catalogue.measure,
  catalogue.safeguard, catalogue.area_safeguard, catalogue.shell_rule,
  catalogue.archetype, catalogue.product, catalogue.product_screen,
  catalogue.screen_content
TO tether_catalogue;

-- ---------------------------------------------------------------------------
-- enrolment-service — enrolments, consents, and the share preview
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA programme, record, catalogue, ops TO tether_enrolment;

-- repository.ts:146,168,195 SELECT; :245 INSERT; :269,284 UPDATE status/ended_at/hidden.
-- Never deleted here: records-service owns erasure.
GRANT SELECT ON programme.enrolment TO tether_enrolment;
GRANT INSERT (account_id, area_id, status) ON programme.enrolment TO tether_enrolment;
GRANT UPDATE (status, ended_at, hidden) ON programme.enrolment TO tether_enrolment;

-- repository.ts:136,348 SELECT; :372 INSERT; :319 UPDATE revoked_at (revocation
-- is a column flip, never a DELETE, so the history survives).
GRANT SELECT ON programme.sharing_consent TO tether_enrolment;
GRANT INSERT (enrolment_id, scope, recipient_kind, recipient_id, consent_version, consent_text)
  ON programme.sharing_consent TO tether_enrolment;
GRANT UPDATE (revoked_at) ON programme.sharing_consent TO tether_enrolment;

-- repository.ts:452-479 reads the caller's own record to build the preview.
-- Read-only: the preview sends nothing and changes nothing.
GRANT SELECT ON record.observation, record.screen_answer, record.lapse_event TO tether_enrolment;

-- repository.ts:214 (shell_rule), :230 (area), :453 (measure label).
GRANT SELECT ON catalogue.shell_rule, catalogue.area, catalogue.measure TO tether_enrolment;

-- audit.ts:73 INSERT.
GRANT INSERT ON ops.audit_event TO tether_enrolment;

-- ---------------------------------------------------------------------------
-- records-service — the patient's own record
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA programme, record, catalogue, ops TO tether_records;

-- postgres-store.ts:143,153,391 SELECT; :417 DELETE (DELETE /record).
GRANT SELECT, DELETE ON programme.enrolment TO tether_records;
-- postgres-store.ts:335 SELECT; :414 DELETE. Reads and erases; never writes a
-- consent, which is the person's act in enrolment-service.
GRANT SELECT, DELETE ON programme.sharing_consent TO tether_records;

-- postgres-store.ts:478 INSERT … ON CONFLICT DO UPDATE (kind, value); :191 DELETE.
GRANT SELECT, DELETE ON record.screen_answer TO tether_records;
GRANT INSERT (enrolment_id, screen_id, block_index, kind, value)
  ON record.screen_answer TO tether_records;
GRANT UPDATE (kind, value) ON record.screen_answer TO tether_records;

-- postgres-store.ts:229 INSERT; :412 DELETE. No UPDATE: a lapse is an event
-- (0003 puts a rule on it as well).
GRANT SELECT, DELETE ON record.lapse_event TO tether_records;
GRANT INSERT (enrolment_id, occurred_at, severity, context)
  ON record.lapse_event TO tether_records;

-- postgres-store.ts:282 INSERT; :411 DELETE. Observations are immutable.
GRANT SELECT, DELETE ON record.observation TO tether_records;
GRANT INSERT (enrolment_id, measure_id, value_num, value_text, unit, observed_at, source, platform)
  ON record.observation TO tether_records;

-- postgres-store.ts:357 — the area's display name, for the export.
GRANT SELECT (id, name) ON catalogue.area TO tether_records;

-- audit.ts:47 INSERT; postgres-store.ts:373 SELECT, to find a sync receipt.
-- `audit_event_subject_read` (0010) limits that read to the caller's own account.
GRANT SELECT, INSERT ON ops.audit_event TO tether_records;

-- ---------------------------------------------------------------------------
-- care-team-service — the one reader across a consent boundary
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA programme, record, care, ops TO tether_care_team;

-- postgres-store.ts:168,202. `consent_text` and `owner_account_id` are not
-- granted: the clinician surface never shows the patient's wording, and the
-- owner column is the policy's, not the service's. (A table's own policies
-- may reference columns the caller cannot select; it is the *other* tables a
-- policy's subquery reads that need a grant, as the policy lines say.)
GRANT SELECT (id, enrolment_id, scope, recipient_kind, recipient_id,
              consent_version, granted_at, revoked_at)
  ON programme.sharing_consent TO tether_care_team;

-- postgres-store.ts:165,234,260. `account_id` is selected for the audit row
-- only (store.ts EnrolmentSummary.subjectAccountId).
GRANT SELECT (id, account_id, area_id, status, joined_on)
  ON programme.enrolment TO tether_care_team;

-- postgres-store.ts:262,379 (notes), :264.
GRANT SELECT (id, enrolment_id, screen_id, block_index, kind, value, answered_at)
  ON record.screen_answer TO tether_care_team;
-- postgres-store.ts:266-270,286 count and date only. The free-text columns are
-- reachable through care.lapse_details(), which checks for a `notes` consent.
GRANT SELECT (id, enrolment_id, occurred_at) ON record.lapse_event TO tether_care_team;
-- postgres-store.ts:272,325,338,427.
GRANT SELECT (id, enrolment_id, measure_id, value_num, value_text, unit, observed_at, source, platform)
  ON record.observation TO tether_care_team;

GRANT EXECUTE ON FUNCTION care.lapse_details(uuid) TO tether_care_team;

-- postgres-store.ts:448 SELECT. Routing is read-only here by design (0005).
GRANT SELECT ON care.escalation_policy TO tether_care_team;
-- postgres-store.ts:460 INSERT; :490 SELECT. No UPDATE and no DELETE.
GRANT SELECT ON care.escalation TO tether_care_team;
GRANT INSERT (enrolment_id, raised_by, consent_id, signal, detail,
              policy_area_id, policy_version, routed_to_kind, routed_to, acknowledge_by)
  ON care.escalation TO tether_care_team;

-- audit.ts:57 INSERT.
GRANT INSERT ON ops.audit_event TO tether_care_team;

-- ---------------------------------------------------------------------------
-- notification-service — devices, preferences, the delivery log
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA ops TO tether_notification;

-- store.ts:37 INSERT … ON CONFLICT (token) DO UPDATE; :68,102 DELETE; :80 SELECT.
GRANT SELECT, DELETE ON ops.device_token TO tether_notification;
GRANT INSERT (account_id, token, platform, area_id) ON ops.device_token TO tether_notification;
GRANT UPDATE (account_id, platform, area_id, last_seen_at) ON ops.device_token TO tether_notification;

-- ops.release_device_token(): registerDevice calls it before the upsert so that a
-- token presented by a new account leaves the old one (see 0010, section 6).
GRANT EXECUTE ON FUNCTION ops.release_device_token(text) TO tether_notification;

-- store.ts:127 SELECT; :159 INSERT … ON CONFLICT (account_id) DO UPDATE.
GRANT SELECT ON ops.notification_preference TO tether_notification;
GRANT INSERT (account_id, specific_content, opted_in_at, consent_text)
  ON ops.notification_preference TO tether_notification;
GRANT UPDATE (specific_content, opted_in_at, consent_text)
  ON ops.notification_preference TO tether_notification;

-- store.ts:187 INSERT only. The log is append-only and holds no message body.
GRANT INSERT (account_id, kind, variant, device_count, delivered_count, failed_count, provider)
  ON ops.notification_log TO tether_notification;

-- ---------------------------------------------------------------------------
-- website-service — the waitlist
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA ops TO tether_website;

-- waitlist.ts:46 SELECT (dedupe window); :53 INSERT; :95 DELETE; :125 purge.
GRANT SELECT (id, email, received_at, purge_after) ON ops.waitlist_enquiry TO tether_website;
GRANT INSERT (name, email, role, interest, message, source) ON ops.waitlist_enquiry TO tether_website;
GRANT DELETE ON ops.waitlist_enquiry TO tether_website;

-- waitlist.ts:163 INSERT.
GRANT INSERT ON ops.audit_event TO tether_website;

-- ---------------------------------------------------------------------------
-- chronic-service — the person's own chronic-care data
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA chronic TO tether_chronic;

-- store.ts:93,124 SELECT; :118 INSERT … ON CONFLICT DO NOTHING; :159 UPDATE.
GRANT SELECT ON chronic.profile TO tether_chronic;
GRANT INSERT (account_id) ON chronic.profile TO tether_chronic;
GRANT UPDATE (display_name, avatar_emoji, dob, health_score) ON chronic.profile TO tether_chronic;

-- store.ts:232,296 SELECT; :259 INSERT … ON CONFLICT (profile_id, kind) DO UPDATE.
GRANT SELECT ON chronic.condition TO tether_chronic;
GRANT INSERT (profile_id, kind, status, goal_value, goal_unit, diagnosed_at)
  ON chronic.condition TO tether_chronic;
GRANT UPDATE (status, goal_value, goal_unit, diagnosed_at) ON chronic.condition TO tether_chronic;

-- store.ts:352 SELECT; :369 INSERT. Readings are immutable.
GRANT SELECT ON chronic.vital_entry TO tether_chronic;
GRANT INSERT (condition_id, metric_key, label, value, unit, note, observed_at, source)
  ON chronic.vital_entry TO tether_chronic;

-- store.ts:456 SELECT; :486 INSERT; :522 DELETE. There is no UPDATE route.
GRANT SELECT, DELETE ON chronic.medication TO tether_chronic;
GRANT INSERT (profile_id, condition_id, name, dosage, schedule, times,
              reminders_enabled, last_taken_at, active)
  ON chronic.medication TO tether_chronic;

-- ---------------------------------------------------------------------------
-- realtime-service — which enrolments may a stream mention
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA programme TO tether_realtime;

-- allowlist.ts: the enrolments the caller owns, and the ones a live consent
-- names them as recipient of. Ids and ownership only: the service never reads a
-- row's contents, which is the whole design of the stream (0008).
GRANT SELECT (id, account_id) ON programme.enrolment TO tether_realtime;
GRANT SELECT (enrolment_id, recipient_id, revoked_at)
  ON programme.sharing_consent TO tether_realtime;
