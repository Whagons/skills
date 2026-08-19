-- Durable sync storage for the Skills Vault project database.
--
-- Why this file exists: the vault UI reads from Gonvex sync collections
-- (gonvex/syncs.go), which need the runtime's durable change log
-- (_gonvex_sync_clock, _gonvex_sync_changes and one stage/finalize trigger
-- pair per synced table) in the project database. The runtime installs that
-- storage while applying tenant schemas, but every vault table is declared
-- as a tenant table and this is a single-mode project with no tenant
-- targets, so the runtime never touches the project database and the UI
-- fails with "relation _gonvex_sync_clock does not exist".
--
-- Generated 2026-08-19 from the Gonvex runtime's own
-- server/internal/schema/sync.go (syncInfrastructureSQL + syncTriggerSQL,
-- identical in 198c7c9d and ef34045) fed with gonvex/_generated/manifest.json.
-- Projected columns per table = sync Columns + Key + OrderBy + EqualArg
-- columns, sorted. Regenerate and re-apply whenever a sync definition in
-- gonvex/syncs.go changes its table, key, or projected columns.
--
-- Apply (idempotent) against the vault project database
-- gonvex_01f1974b_dcda_6fc3_b16d_9acf5f3b4192:
--   psql -v ON_ERROR_STOP=1 -f scripts/install-sync-storage.sql
-- Verify:
--   select to_regclass('public._gonvex_sync_clock');
BEGIN;

CREATE TABLE IF NOT EXISTS _gonvex_sync_clock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  retained_revision bigint NOT NULL DEFAULT 0
);
ALTER TABLE _gonvex_sync_clock
  ADD COLUMN IF NOT EXISTS retained_revision bigint NOT NULL DEFAULT 0;
INSERT INTO _gonvex_sync_clock (singleton, epoch, revision)
VALUES (true, md5(random()::text || clock_timestamp()::text), 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS _gonvex_sync_changes (
  event_id bigserial PRIMARY KEY,
  transaction_id bigint NOT NULL,
  revision bigint,
  ordinal integer,
  mutation_id text,
  table_name text NOT NULL,
  row_id text NOT NULL,
  operation text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  changed_columns text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS gonvex_sync_changes_revision
  ON _gonvex_sync_changes (revision, ordinal)
  WHERE revision IS NOT NULL;
CREATE INDEX IF NOT EXISTS gonvex_sync_changes_created_at
  ON _gonvex_sync_changes (created_at);

CREATE OR REPLACE FUNCTION gonvex_sync_finalize_transaction() RETURNS trigger AS $$
DECLARE
  revision_text text;
  next_revision bigint;
  current_epoch text;
  changed_tables text[];
  notify_payload jsonb;
BEGIN
  revision_text := current_setting('gonvex.sync_revision', true);
  IF revision_text IS NULL OR revision_text = '' THEN
    UPDATE _gonvex_sync_clock
    SET revision = revision + 1
    WHERE singleton = true
    RETURNING revision, epoch INTO next_revision, current_epoch;

    PERFORM set_config('gonvex.sync_revision', next_revision::text, true);

    WITH ranked AS (
      SELECT event_id, row_number() OVER (ORDER BY event_id)::integer AS row_ordinal
      FROM _gonvex_sync_changes
      WHERE transaction_id = txid_current()::bigint AND revision IS NULL
    )
    UPDATE _gonvex_sync_changes changes
    SET revision = next_revision,
        ordinal = ranked.row_ordinal,
        mutation_id = NULLIF(current_setting('gonvex.mutation_id', true), '')
    FROM ranked
    WHERE changes.event_id = ranked.event_id;

    SELECT array_agg(DISTINCT table_name ORDER BY table_name)
    INTO changed_tables
    FROM _gonvex_sync_changes
    WHERE transaction_id = txid_current()::bigint
      AND revision = next_revision;

    notify_payload := jsonb_build_object(
      'epoch', current_epoch,
      'revision', next_revision,
      'tables', changed_tables
    );
    IF octet_length(notify_payload::text) > 7000 THEN
      notify_payload := jsonb_build_object(
        'epoch', current_epoch,
        'revision', next_revision
      );
    END IF;

    PERFORM pg_notify(
      'gonvex_sync_change',
      notify_payload::text
    );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "gonvex_sync_skill_api_keys_stage"() RETURNS trigger AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  changed_columns text[];
  row_key text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    old_data := NULL;
    new_data := jsonb_build_object('created_at', NEW."created_at", 'created_by', NEW."created_by", 'expires_at', NEW."expires_at", 'id', NEW."id", 'name', NEW."name", 'owner_id', NEW."owner_id", 'prefix', NEW."prefix", 'revoked_at', NEW."revoked_at", 'scopes', NEW."scopes");
    row_key := NEW."id"::text;
    changed_columns := ARRAY(SELECT jsonb_object_keys(new_data));
  ELSIF TG_OP = 'DELETE' THEN
    old_data := jsonb_build_object('created_at', OLD."created_at", 'created_by', OLD."created_by", 'expires_at', OLD."expires_at", 'id', OLD."id", 'name', OLD."name", 'owner_id', OLD."owner_id", 'prefix', OLD."prefix", 'revoked_at', OLD."revoked_at", 'scopes', OLD."scopes");
    new_data := NULL;
    row_key := OLD."id"::text;
    changed_columns := ARRAY(SELECT jsonb_object_keys(old_data));
  ELSE
    old_data := jsonb_build_object('created_at', OLD."created_at", 'created_by', OLD."created_by", 'expires_at', OLD."expires_at", 'id', OLD."id", 'name', OLD."name", 'owner_id', OLD."owner_id", 'prefix', OLD."prefix", 'revoked_at', OLD."revoked_at", 'scopes', OLD."scopes");
    new_data := jsonb_build_object('created_at', NEW."created_at", 'created_by', NEW."created_by", 'expires_at', NEW."expires_at", 'id', NEW."id", 'name', NEW."name", 'owner_id', NEW."owner_id", 'prefix', NEW."prefix", 'revoked_at', NEW."revoked_at", 'scopes', NEW."scopes");
    row_key := NEW."id"::text;
    changed_columns := ARRAY(
      SELECT key
      FROM jsonb_object_keys(old_data || new_data) AS changed(key)
      WHERE old_data -> key IS DISTINCT FROM new_data -> key
      ORDER BY key
    );
  END IF;

  INSERT INTO _gonvex_sync_changes (
    transaction_id, table_name, row_id, operation, old_value, new_value, changed_columns
  ) VALUES (
    txid_current()::bigint, 'skill_api_keys', row_key, lower(TG_OP), old_data, new_data, changed_columns
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "gonvex_sync_skill_api_keys_stage_trigger" ON "skill_api_keys";
DROP TRIGGER IF EXISTS "gonvex_sync_skill_api_keys_finalize_trigger" ON "skill_api_keys";
CREATE TRIGGER "gonvex_sync_skill_api_keys_stage_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "skill_api_keys"
FOR EACH ROW EXECUTE FUNCTION "gonvex_sync_skill_api_keys_stage"();
CREATE CONSTRAINT TRIGGER "gonvex_sync_skill_api_keys_finalize_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "skill_api_keys"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gonvex_sync_finalize_transaction();

CREATE OR REPLACE FUNCTION "gonvex_sync_skill_credentials_stage"() RETURNS trigger AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  changed_columns text[];
  row_key text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    old_data := NULL;
    new_data := jsonb_build_object('created_at', NEW."created_at", 'id', NEW."id", 'name', NEW."name", 'owner_id', NEW."owner_id", 'summary', NEW."summary", 'updated_at', NEW."updated_at");
    row_key := NEW."id"::text;
    changed_columns := ARRAY(SELECT jsonb_object_keys(new_data));
  ELSIF TG_OP = 'DELETE' THEN
    old_data := jsonb_build_object('created_at', OLD."created_at", 'id', OLD."id", 'name', OLD."name", 'owner_id', OLD."owner_id", 'summary', OLD."summary", 'updated_at', OLD."updated_at");
    new_data := NULL;
    row_key := OLD."id"::text;
    changed_columns := ARRAY(SELECT jsonb_object_keys(old_data));
  ELSE
    old_data := jsonb_build_object('created_at', OLD."created_at", 'id', OLD."id", 'name', OLD."name", 'owner_id', OLD."owner_id", 'summary', OLD."summary", 'updated_at', OLD."updated_at");
    new_data := jsonb_build_object('created_at', NEW."created_at", 'id', NEW."id", 'name', NEW."name", 'owner_id', NEW."owner_id", 'summary', NEW."summary", 'updated_at', NEW."updated_at");
    row_key := NEW."id"::text;
    changed_columns := ARRAY(
      SELECT key
      FROM jsonb_object_keys(old_data || new_data) AS changed(key)
      WHERE old_data -> key IS DISTINCT FROM new_data -> key
      ORDER BY key
    );
  END IF;

  INSERT INTO _gonvex_sync_changes (
    transaction_id, table_name, row_id, operation, old_value, new_value, changed_columns
  ) VALUES (
    txid_current()::bigint, 'skill_credentials', row_key, lower(TG_OP), old_data, new_data, changed_columns
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "gonvex_sync_skill_credentials_stage_trigger" ON "skill_credentials";
DROP TRIGGER IF EXISTS "gonvex_sync_skill_credentials_finalize_trigger" ON "skill_credentials";
CREATE TRIGGER "gonvex_sync_skill_credentials_stage_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "skill_credentials"
FOR EACH ROW EXECUTE FUNCTION "gonvex_sync_skill_credentials_stage"();
CREATE CONSTRAINT TRIGGER "gonvex_sync_skill_credentials_finalize_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "skill_credentials"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gonvex_sync_finalize_transaction();

CREATE OR REPLACE FUNCTION "gonvex_sync_skill_workspace_invitations_stage"() RETURNS trigger AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  changed_columns text[];
  row_key text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    old_data := NULL;
    new_data := jsonb_build_object('accepted_at', NEW."accepted_at", 'created_at', NEW."created_at", 'email', NEW."email", 'id', NEW."id", 'invited_by', NEW."invited_by", 'rejected_at', NEW."rejected_at", 'workspace_owner_id', NEW."workspace_owner_id");
    row_key := NEW."id"::text;
    changed_columns := ARRAY(SELECT jsonb_object_keys(new_data));
  ELSIF TG_OP = 'DELETE' THEN
    old_data := jsonb_build_object('accepted_at', OLD."accepted_at", 'created_at', OLD."created_at", 'email', OLD."email", 'id', OLD."id", 'invited_by', OLD."invited_by", 'rejected_at', OLD."rejected_at", 'workspace_owner_id', OLD."workspace_owner_id");
    new_data := NULL;
    row_key := OLD."id"::text;
    changed_columns := ARRAY(SELECT jsonb_object_keys(old_data));
  ELSE
    old_data := jsonb_build_object('accepted_at', OLD."accepted_at", 'created_at', OLD."created_at", 'email', OLD."email", 'id', OLD."id", 'invited_by', OLD."invited_by", 'rejected_at', OLD."rejected_at", 'workspace_owner_id', OLD."workspace_owner_id");
    new_data := jsonb_build_object('accepted_at', NEW."accepted_at", 'created_at', NEW."created_at", 'email', NEW."email", 'id', NEW."id", 'invited_by', NEW."invited_by", 'rejected_at', NEW."rejected_at", 'workspace_owner_id', NEW."workspace_owner_id");
    row_key := NEW."id"::text;
    changed_columns := ARRAY(
      SELECT key
      FROM jsonb_object_keys(old_data || new_data) AS changed(key)
      WHERE old_data -> key IS DISTINCT FROM new_data -> key
      ORDER BY key
    );
  END IF;

  INSERT INTO _gonvex_sync_changes (
    transaction_id, table_name, row_id, operation, old_value, new_value, changed_columns
  ) VALUES (
    txid_current()::bigint, 'skill_workspace_invitations', row_key, lower(TG_OP), old_data, new_data, changed_columns
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "gonvex_sync_skill_workspace_invitations_stage_trigger" ON "skill_workspace_invitations";
DROP TRIGGER IF EXISTS "gonvex_sync_skill_workspace_invitations_finalize_trigger" ON "skill_workspace_invitations";
CREATE TRIGGER "gonvex_sync_skill_workspace_invitations_stage_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "skill_workspace_invitations"
FOR EACH ROW EXECUTE FUNCTION "gonvex_sync_skill_workspace_invitations_stage"();
CREATE CONSTRAINT TRIGGER "gonvex_sync_skill_workspace_invitations_finalize_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "skill_workspace_invitations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gonvex_sync_finalize_transaction();

CREATE OR REPLACE FUNCTION "gonvex_sync_skill_workspace_members_stage"() RETURNS trigger AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  changed_columns text[];
  row_key text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    old_data := NULL;
    new_data := jsonb_build_object('created_at', NEW."created_at", 'email', NEW."email", 'id', NEW."id", 'invited_by', NEW."invited_by", 'workspace_owner_id', NEW."workspace_owner_id");
    row_key := NEW."id"::text;
    changed_columns := ARRAY(SELECT jsonb_object_keys(new_data));
  ELSIF TG_OP = 'DELETE' THEN
    old_data := jsonb_build_object('created_at', OLD."created_at", 'email', OLD."email", 'id', OLD."id", 'invited_by', OLD."invited_by", 'workspace_owner_id', OLD."workspace_owner_id");
    new_data := NULL;
    row_key := OLD."id"::text;
    changed_columns := ARRAY(SELECT jsonb_object_keys(old_data));
  ELSE
    old_data := jsonb_build_object('created_at', OLD."created_at", 'email', OLD."email", 'id', OLD."id", 'invited_by', OLD."invited_by", 'workspace_owner_id', OLD."workspace_owner_id");
    new_data := jsonb_build_object('created_at', NEW."created_at", 'email', NEW."email", 'id', NEW."id", 'invited_by', NEW."invited_by", 'workspace_owner_id', NEW."workspace_owner_id");
    row_key := NEW."id"::text;
    changed_columns := ARRAY(
      SELECT key
      FROM jsonb_object_keys(old_data || new_data) AS changed(key)
      WHERE old_data -> key IS DISTINCT FROM new_data -> key
      ORDER BY key
    );
  END IF;

  INSERT INTO _gonvex_sync_changes (
    transaction_id, table_name, row_id, operation, old_value, new_value, changed_columns
  ) VALUES (
    txid_current()::bigint, 'skill_workspace_members', row_key, lower(TG_OP), old_data, new_data, changed_columns
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "gonvex_sync_skill_workspace_members_stage_trigger" ON "skill_workspace_members";
DROP TRIGGER IF EXISTS "gonvex_sync_skill_workspace_members_finalize_trigger" ON "skill_workspace_members";
CREATE TRIGGER "gonvex_sync_skill_workspace_members_stage_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "skill_workspace_members"
FOR EACH ROW EXECUTE FUNCTION "gonvex_sync_skill_workspace_members_stage"();
CREATE CONSTRAINT TRIGGER "gonvex_sync_skill_workspace_members_finalize_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "skill_workspace_members"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gonvex_sync_finalize_transaction();

CREATE OR REPLACE FUNCTION "gonvex_sync_skills_stage"() RETURNS trigger AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  changed_columns text[];
  row_key text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    old_data := NULL;
    new_data := jsonb_build_object('approved_at', NEW."approved_at", 'approved_by', NEW."approved_by", 'content', NEW."content", 'created_at', NEW."created_at", 'id', NEW."id", 'name', NEW."name", 'owner_id', NEW."owner_id", 'summary', NEW."summary", 'updated_at', NEW."updated_at");
    row_key := NEW."id"::text;
    changed_columns := ARRAY(SELECT jsonb_object_keys(new_data));
  ELSIF TG_OP = 'DELETE' THEN
    old_data := jsonb_build_object('approved_at', OLD."approved_at", 'approved_by', OLD."approved_by", 'content', OLD."content", 'created_at', OLD."created_at", 'id', OLD."id", 'name', OLD."name", 'owner_id', OLD."owner_id", 'summary', OLD."summary", 'updated_at', OLD."updated_at");
    new_data := NULL;
    row_key := OLD."id"::text;
    changed_columns := ARRAY(SELECT jsonb_object_keys(old_data));
  ELSE
    old_data := jsonb_build_object('approved_at', OLD."approved_at", 'approved_by', OLD."approved_by", 'content', OLD."content", 'created_at', OLD."created_at", 'id', OLD."id", 'name', OLD."name", 'owner_id', OLD."owner_id", 'summary', OLD."summary", 'updated_at', OLD."updated_at");
    new_data := jsonb_build_object('approved_at', NEW."approved_at", 'approved_by', NEW."approved_by", 'content', NEW."content", 'created_at', NEW."created_at", 'id', NEW."id", 'name', NEW."name", 'owner_id', NEW."owner_id", 'summary', NEW."summary", 'updated_at', NEW."updated_at");
    row_key := NEW."id"::text;
    changed_columns := ARRAY(
      SELECT key
      FROM jsonb_object_keys(old_data || new_data) AS changed(key)
      WHERE old_data -> key IS DISTINCT FROM new_data -> key
      ORDER BY key
    );
  END IF;

  INSERT INTO _gonvex_sync_changes (
    transaction_id, table_name, row_id, operation, old_value, new_value, changed_columns
  ) VALUES (
    txid_current()::bigint, 'skills', row_key, lower(TG_OP), old_data, new_data, changed_columns
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "gonvex_sync_skills_stage_trigger" ON "skills";
DROP TRIGGER IF EXISTS "gonvex_sync_skills_finalize_trigger" ON "skills";
CREATE TRIGGER "gonvex_sync_skills_stage_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "skills"
FOR EACH ROW EXECUTE FUNCTION "gonvex_sync_skills_stage"();
CREATE CONSTRAINT TRIGGER "gonvex_sync_skills_finalize_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "skills"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gonvex_sync_finalize_transaction();
COMMIT;
