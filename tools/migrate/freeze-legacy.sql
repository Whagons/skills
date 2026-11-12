-- Run with psql -v ON_ERROR_STOP=1 against the retired Skills database only.
-- Existing tokens must already be revoked. This also blocks fresh sign-ins.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $$
BEGIN
  IF current_database() <> 'gonvex_01f1974b_dcda_6fc3_b16d_9acf5f3b4192' THEN
    RAISE EXCEPTION 'Refusing to freeze a database other than the retired Skills vault';
  END IF;
  IF EXISTS (SELECT 1 FROM public.skill_api_keys
             WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))
     OR EXISTS (SELECT 1 FROM public.skill_sessions
                WHERE revoked_at IS NULL AND expires_at > now()) THEN
    RAISE EXCEPTION 'Revoke active legacy keys and sessions before freezing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.skills_cloudflare_cutover_read_only_20261111()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Skills vault moved to https://skills.whagons.com; legacy database is read-only'
    USING ERRCODE = '25006';
END $$;

DO $$
DECLARE vault_table text;
BEGIN
  FOREACH vault_table IN ARRAY ARRAY[
    'skill_users', 'skill_sessions', 'skills', 'skill_api_keys',
    'skill_credentials', 'skill_workspace_members',
    'skill_workspace_invitations', 'skill_access_roles'
  ] LOOP
    EXECUTE format('CREATE OR REPLACE TRIGGER skills_cloudflare_cutover_read_only_20261111
                    BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I
                    FOR EACH STATEMENT EXECUTE FUNCTION public.skills_cloudflare_cutover_read_only_20261111()',
                   vault_table);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER skills_cloudflare_cutover_read_only_20261111',
                   vault_table);
  END LOOP;
END $$;
COMMIT;
