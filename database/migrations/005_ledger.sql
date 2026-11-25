-- Libro único de movimientos económicos (issue #30).
CREATE TABLE IF NOT EXISTS ledger_entries (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  entry_date date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  entry_type text NOT NULL CHECK (entry_type IN ('income','expense')),
  category text NOT NULL, account text NOT NULL DEFAULT 'cash' CHECK (account IN ('cash','bank')),
  amount_net numeric(12,2) NOT NULL CHECK (amount_net > 0), vat numeric(12,2) NOT NULL DEFAULT 0 CHECK (vat >= 0),
  total numeric(12,2) NOT NULL, source_type text, source_id uuid, reference text, notes text,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_source_unique ON ledger_entries(tenant_id,source_type,source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_date_idx ON ledger_entries(tenant_id,entry_date DESC);
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_entries
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
