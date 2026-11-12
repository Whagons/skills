-- Run only during an authorized rollback, before restoring data or tokens.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
DO $$
DECLARE vault_table text;
BEGIN
  IF current_database() <> 'gonvex_01f1974b_dcda_6fc3_b16d_9acf5f3b4192' THEN
    RAISE EXCEPTION 'Refusing to unfreeze a database other than the retired Skills vault';
  END IF;
  FOREACH vault_table IN ARRAY ARRAY[
    'skill_users', 'skill_sessions', 'skills', 'skill_api_keys',
    'skill_credentials', 'skill_workspace_members',
    'skill_workspace_invitations', 'skill_access_roles'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS skills_cloudflare_cutover_read_only_20261111 ON public.%I',
                   vault_table);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.skills_cloudflare_cutover_read_only_20261111();
COMMIT;
