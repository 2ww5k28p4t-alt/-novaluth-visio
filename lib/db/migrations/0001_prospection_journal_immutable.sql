-- The journal is append-only.  The narrowly scoped setting is intentionally
-- available only to the disposable isolated-cluster role so integration-test
-- teardown can remove its own fixtures without weakening application paths.
CREATE OR REPLACE FUNCTION prospection_journal_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user = 'schema_check'
     AND current_setting('novaluth.prospection_journal_test_cleanup', true) = 'enabled' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION 'prospection_journal is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS prospection_journal_immutable ON prospection_journal;
CREATE TRIGGER prospection_journal_immutable
BEFORE UPDATE OR DELETE ON prospection_journal
FOR EACH ROW EXECUTE FUNCTION prospection_journal_reject_mutation();