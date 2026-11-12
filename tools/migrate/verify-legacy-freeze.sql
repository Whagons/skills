-- Check the retired database's guard without reading or changing vault rows.
-- Run with psql -v ON_ERROR_STOP=1. Every attempted operation is rolled back.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
DO $$
DECLARE
  vault_table text;
  first_column text;
  operation text;
  verified integer := 0;
BEGIN
  IF current_database() <> 'gonvex_01f1974b_dcda_6fc3_b16d_9acf5f3b4192' THEN
    RAISE EXCEPTION 'Refusing to probe a database other than the retired Skills vault';
  END IF;
  FOREACH vault_table IN ARRAY ARRAY[
    'skill_users', 'skill_sessions', 'skills', 'skill_api_keys',
    'skill_credentials', 'skill_workspace_members',
    'skill_workspace_invitations', 'skill_access_roles'
  ] LOOP
    SELECT column_name INTO STRICT first_column FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = vault_table
      ORDER BY ordinal_position LIMIT 1;
    FOREACH operation IN ARRAY ARRAY[
      format('INSERT INTO public.%I SELECT * FROM public.%I WHERE false', vault_table, vault_table),
      format('UPDATE public.%I SET %I = %I WHERE false', vault_table, first_column, first_column),
      format('DELETE FROM public.%I WHERE false', vault_table),
      format('TRUNCATE public.%I', vault_table)
    ] LOOP
      BEGIN
        EXECUTE operation;
        -- An unexpected success raises inside the subtransaction so even a
        -- broken guard cannot leave the operation applied.
        RAISE EXCEPTION 'Legacy write guard did not reject %', operation;
      EXCEPTION WHEN read_only_sql_transaction THEN
        verified := verified + 1;
      END;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'Verified % blocked operations across 8 legacy vault tables', verified;
END $$;
ROLLBACK;
