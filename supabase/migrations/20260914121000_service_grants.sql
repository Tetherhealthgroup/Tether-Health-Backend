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

-- 0004 already granted tether_auth table-wide SELECT, INSERT, UPDATE and DELETE on
-- two tables, and its header is the argument for scoping this role to identity.
-- Neither table is written whole by the code, and nothing deletes a session row
-- (an account's sessions go with it by cascade, which runs as the table owner),
-- so the table-wide grants are withdrawn and replaced by what the statements use.
REVOKE ALL ON identity.account, identity.refresh_session FROM tether_auth;

GRANT USAGE ON SCHEMA identity, ops TO tether_auth;

-- auth-service/src/accounts.ts:70 INSERT … ON CONFLICT (external_id) DO UPDATE
--   (the sign-in upsert), :114 SELECT by id (GET /me), :165 SELECT … FOR UPDATE
--   and :196 DELETE (DELETE /me, which cascades to every enrolment).
GRANT SELECT, DELETE ON identity.account TO tether_auth;
GRANT INSERT (external_id, email, last_seen_at) ON identity.account TO tether_auth;
GRANT UPDATE (email, last_seen_at) ON identity.account TO tether_auth;

-- auth-service/src/store.ts:64 SELECT … FOR UPDATE, :75 INSERT, :100,109,120 UPDATE
-- of the revocation columns.
GRANT SELECT ON identity.refresh_session TO tether_auth;
GRANT INSERT (account_id, family_id, token_hash, issued_at, expires_at, user_agent, ip)
  ON identity.refresh_session TO tether_auth;
GRANT UPDATE (revoked_at, revoked_reason) ON identity.refresh_session TO tether_auth;

-- auth-service/src/accounts.ts:179 INSERT only. The audit row outlives the
-- account it describes.
GRANT INSERT ON ops.audit_event TO tether_auth;

-- ---------------------------------------------------------------------------
-- catalogue-service — read-only, and non-PHI
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA catalogue TO tether_catalogue;

-- catalogue-service/src/repository.ts:238-468 reads each of these and writes none. 0002 says the
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

-- enrolment-service/src/repository.ts:171,199,230 SELECT; :282 INSERT; :307,323
-- UPDATE status/ended_at/hidden. Never deleted here: records-service owns erasure.
GRANT SELECT ON programme.enrolment TO tether_enrolment;
GRANT INSERT (account_id, area_id, status) ON programme.enrolment TO tether_enrolment;
GRANT UPDATE (status, ended_at, hidden) ON programme.enrolment TO tether_enrolment;

-- repository.ts:156,396 SELECT; :430 INSERT; :359 UPDATE revoked_at (revocation
-- is a column flip, never a DELETE, so the history survives).
GRANT SELECT ON programme.sharing_consent TO tether_enrolment;
GRANT INSERT (enrolment_id, scope, recipient_kind, recipient_id, consent_version, consent_text)
  ON programme.sharing_consent TO tether_enrolment;
GRANT UPDATE (revoked_at) ON programme.sharing_consent TO tether_enrolment;

-- repository.ts:506-543 reads the caller's own record to build the preview.
-- Read-only: the preview sends nothing and changes nothing.
GRANT SELECT ON record.observation, record.screen_answer, record.lapse_event TO tether_enrolment;

-- repository.ts:251 (shell_rule), :267 (area), :515 (measure label).
GRANT SELECT (id, rule) ON catalogue.shell_rule TO tether_enrolment;
GRANT SELECT (id, name, product_id) ON catalogue.area TO tether_enrolment;
GRANT SELECT (id, label) ON catalogue.measure TO tether_enrolment;

-- enrolment-service/src/audit.ts:73 INSERT.
GRANT INSERT ON ops.audit_event TO tether_enrolment;

-- ---------------------------------------------------------------------------
-- records-service — the patient's own record
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA programme, record, catalogue, ops TO tether_records;

-- records-service/src/postgres-store.ts:144,154,398 SELECT; :424 DELETE (DELETE /record).
GRANT SELECT, DELETE ON programme.enrolment TO tether_records;
-- postgres-store.ts:342 SELECT; :409 DELETE. Reads and erases; never writes a
-- consent, which is the person's act in enrolment-service.
GRANT SELECT, DELETE ON programme.sharing_consent TO tether_records;

-- postgres-store.ts:485 INSERT … ON CONFLICT DO UPDATE (kind, value); :195 DELETE.
GRANT SELECT, DELETE ON record.screen_answer TO tether_records;
GRANT INSERT (enrolment_id, screen_id, block_index, kind, value)
  ON record.screen_answer TO tether_records;
GRANT UPDATE (kind, value) ON record.screen_answer TO tether_records;

-- postgres-store.ts:236 INSERT; :409 DELETE. No UPDATE: a lapse is an event
-- (0003 puts a rule on it as well).
GRANT SELECT, DELETE ON record.lapse_event TO tether_records;
GRANT INSERT (enrolment_id, occurred_at, severity, context)
  ON record.lapse_event TO tether_records;

-- postgres-store.ts:289 INSERT; :409 DELETE. Observations are immutable.
GRANT SELECT, DELETE ON record.observation TO tether_records;
GRANT INSERT (enrolment_id, measure_id, value_num, value_text, unit, observed_at, source, platform)
  ON record.observation TO tether_records;

-- postgres-store.ts:364 — the area's display name, for the export.
GRANT SELECT (id, name) ON catalogue.area TO tether_records;

-- records-service/src/audit.ts:52 INSERT; postgres-store.ts:381 SELECT, to find
-- a sync receipt.
-- `audit_event_subject_read` (0010) limits that read to the caller's own account.
GRANT SELECT, INSERT ON ops.audit_event TO tether_records;

-- ---------------------------------------------------------------------------
-- care-team-service — the one reader across a consent boundary
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA programme, record, care, ops TO tether_care_team;

-- care-team-service/src/postgres-store.ts:201,237. `consent_text` and `owner_account_id` are not
-- granted: the clinician surface never shows the patient's wording, and the
-- owner column is the policy's, not the service's. (A table's own policies
-- may reference columns the caller cannot select; it is the *other* tables a
-- policy's subquery reads that need a grant, as the policy lines say.)
GRANT SELECT (id, enrolment_id, scope, recipient_kind, recipient_id,
              consent_version, granted_at, revoked_at)
  ON programme.sharing_consent TO tether_care_team;

-- postgres-store.ts:198-202,267,309. `account_id` is selected for the audit row
-- only (store.ts EnrolmentSummary.subjectAccountId).
GRANT SELECT (id, account_id, area_id, status, joined_on)
  ON programme.enrolment TO tether_care_team;

-- postgres-store.ts:295,297 (counts), :414 (notes).
GRANT SELECT (id, enrolment_id, screen_id, block_index, kind, value, answered_at)
  ON record.screen_answer TO tether_care_team;
-- postgres-store.ts:299-303,319 count and date only. The free-text columns are
-- reachable through care.lapse_details() (:441), which checks for a `notes`
-- consent.
GRANT SELECT (id, enrolment_id, occurred_at) ON record.lapse_event TO tether_care_team;
-- postgres-store.ts:305-307,358,372,464.
GRANT SELECT (id, enrolment_id, measure_id, value_num, value_text, unit, observed_at, source, platform)
  ON record.observation TO tether_care_team;

GRANT EXECUTE ON FUNCTION care.lapse_details(uuid) TO tether_care_team;

-- postgres-store.ts:487 SELECT. Routing is read-only here by design (0005).
GRANT SELECT ON care.escalation_policy TO tether_care_team;
-- postgres-store.ts:503 INSERT; :538 SELECT. No UPDATE and no DELETE.
GRANT SELECT ON care.escalation TO tether_care_team;
GRANT INSERT (enrolment_id, raised_by, consent_id, signal, detail,
              policy_area_id, policy_version, routed_to_kind, routed_to, acknowledge_by)
  ON care.escalation TO tether_care_team;

-- care-team-service/src/audit.ts:62 INSERT.
GRANT INSERT ON ops.audit_event TO tether_care_team;

-- ---------------------------------------------------------------------------
-- notification-service — devices, preferences, the delivery log
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA ops TO tether_notification;

-- notification-service/src/store.ts:45 INSERT … ON CONFLICT (token) DO UPDATE;
-- :76,110 DELETE; :88 SELECT.
GRANT SELECT, DELETE ON ops.device_token TO tether_notification;
GRANT INSERT (account_id, token, platform, area_id) ON ops.device_token TO tether_notification;
GRANT UPDATE (account_id, platform, area_id, last_seen_at) ON ops.device_token TO tether_notification;

-- ops.release_device_token(): registerDevice calls it before the upsert so that a
-- token presented by a new account leaves the old one (see 0010, section 6).
GRANT EXECUTE ON FUNCTION ops.release_device_token(text) TO tether_notification;

-- store.ts:135 SELECT; :167 INSERT … ON CONFLICT (account_id) DO UPDATE.
GRANT SELECT ON ops.notification_preference TO tether_notification;
GRANT INSERT (account_id, specific_content, opted_in_at, consent_text)
  ON ops.notification_preference TO tether_notification;
GRANT UPDATE (specific_content, opted_in_at, consent_text)
  ON ops.notification_preference TO tether_notification;

-- store.ts:195 INSERT only. The log is append-only and holds no message body.
GRANT INSERT (account_id, kind, variant, device_count, delivered_count, failed_count, provider)
  ON ops.notification_log TO tether_notification;

-- ---------------------------------------------------------------------------
-- website-service — the waitlist
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA ops TO tether_website;

-- website-service/src/waitlist.ts:46 SELECT (dedupe window); :53 INSERT; :95
-- DELETE; :124-126 purge.
GRANT SELECT (id, email, received_at, purge_after) ON ops.waitlist_enquiry TO tether_website;
GRANT INSERT (name, email, role, interest, message, source) ON ops.waitlist_enquiry TO tether_website;
GRANT DELETE ON ops.waitlist_enquiry TO tether_website;

-- waitlist.ts:163 INSERT.
GRANT INSERT ON ops.audit_event TO tether_website;

-- ---------------------------------------------------------------------------
-- chronic-service — the person's own chronic-care data
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA chronic TO tether_chronic;

-- chronic-service/src/store.ts:96,127 SELECT; :121 INSERT … ON CONFLICT DO NOTHING;
-- :162 UPDATE.
GRANT SELECT ON chronic.profile TO tether_chronic;
GRANT INSERT (account_id) ON chronic.profile TO tether_chronic;
GRANT UPDATE (display_name, avatar_emoji, dob, health_score) ON chronic.profile TO tether_chronic;

-- store.ts:236,301 SELECT; :262 INSERT … ON CONFLICT (profile_id, kind) DO UPDATE.
GRANT SELECT ON chronic.condition TO tether_chronic;
GRANT INSERT (profile_id, kind, status, goal_value, goal_unit, diagnosed_at)
  ON chronic.condition TO tether_chronic;
GRANT UPDATE (status, goal_value, goal_unit, diagnosed_at) ON chronic.condition TO tether_chronic;

-- store.ts:361 SELECT; :386 INSERT. Readings are immutable.
GRANT SELECT ON chronic.vital_entry TO tether_chronic;
GRANT INSERT (condition_id, metric_key, label, value, unit, note, observed_at, source)
  ON chronic.vital_entry TO tether_chronic;

-- store.ts:477 SELECT; :507 INSERT; :556 DELETE. There is no UPDATE route.
GRANT SELECT, DELETE ON chronic.medication TO tether_chronic;
GRANT INSERT (profile_id, condition_id, name, dosage, schedule, times,
              reminders_enabled, last_taken_at, active)
  ON chronic.medication TO tether_chronic;

-- ---------------------------------------------------------------------------
-- realtime-service — which enrolments may a stream mention
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA programme TO tether_realtime;

-- realtime-service/src/allowlist.ts:29,34: the enrolments the caller owns, and the ones a live consent
-- names them as recipient of. Ids and ownership only: the service never reads a
-- row's contents, which is the whole design of the stream (0008).
GRANT SELECT (id, account_id) ON programme.enrolment TO tether_realtime;
GRANT SELECT (enrolment_id, recipient_id, revoked_at)
  ON programme.sharing_consent TO tether_realtime;
