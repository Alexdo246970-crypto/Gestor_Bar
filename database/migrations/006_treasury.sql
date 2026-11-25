-- Tesorería operativa: cuentas, traspasos y compromisos (issue #62).
CREATE TABLE IF NOT EXISTS treasury_accounts (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('cash','bank')), name text NOT NULL,
  initial_balance numeric(12,2) NOT NULL DEFAULT 0, iban text, active boolean NOT NULL DEFAULT true,
  opening_reason text, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
ALTER TABLE treasury_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON treasury_accounts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE UNIQUE INDEX IF NOT EXISTS treasury_one_account_per_kind
  ON treasury_accounts(tenant_id,kind) WHERE active;

CREATE TABLE IF NOT EXISTS treasury_transfers (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  from_account_id uuid NOT NULL, to_account_id uuid NOT NULL, amount numeric(12,2) NOT NULL CHECK (amount > 0),
  transfer_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Europe/Madrid')::date, notes text, created_by uuid REFERENCES users(id),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,from_account_id) REFERENCES treasury_accounts(tenant_id,id),
  FOREIGN KEY (tenant_id,to_account_id) REFERENCES treasury_accounts(tenant_id,id)
);
ALTER TABLE treasury_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON treasury_transfers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS treasury_commitments (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  description text NOT NULL, amount numeric(12,2) NOT NULL CHECK (amount > 0), due_date date,
  source_type text NOT NULL DEFAULT 'manual', source_id uuid, account text NOT NULL DEFAULT 'bank' CHECK (account IN ('cash','bank')),
  paid boolean NOT NULL DEFAULT false, paid_at timestamptz, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
ALTER TABLE treasury_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_commitments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON treasury_commitments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE UNIQUE INDEX IF NOT EXISTS treasury_commitment_source_unique
  ON treasury_commitments(tenant_id,source_type,source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS treasury_commitments_due_idx ON treasury_commitments(tenant_id,due_date) WHERE NOT paid;
