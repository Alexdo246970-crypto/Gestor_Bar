-- Un pedido puede tener un apunte por cuenta (efectivo y tarjeta) en el libro (issue #62).
DROP INDEX IF EXISTS ledger_source_unique;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_source_account_unique
  ON ledger_entries(tenant_id, source_type, source_id, account)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
