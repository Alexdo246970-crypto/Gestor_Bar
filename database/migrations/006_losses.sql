-- Clasificación y valoración de pérdidas (issue #64).
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reason text;
UPDATE stock_movements SET reason='other' WHERE reason IS NULL AND quantity_delta<0;
ALTER TABLE stock_movements ALTER COLUMN reason SET DEFAULT 'other';
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_reason_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_reason_check
  CHECK (reason IS NULL OR reason IN ('waste','breakage','staff_meal','invitation','count_error','expiry','other'));
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS loss_value numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS employee_id uuid;

CREATE TABLE IF NOT EXISTS loss_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id), threshold_pct numeric(5,2) NOT NULL DEFAULT 3 CHECK (threshold_pct >= 0)
);
ALTER TABLE loss_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE loss_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON loss_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS loss_entries (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  description text NOT NULL, amount numeric(12,2) NOT NULL CHECK (amount > 0), signed_amount numeric(12,2) NOT NULL,
  reason text NOT NULL CHECK (reason IN ('waste','breakage','staff_meal','invitation','count_error','expiry','other')),
  source_type text NOT NULL, source_id uuid, occurred_at date NOT NULL DEFAULT (now() AT TIME ZONE 'Europe/Madrid')::date,
  notes text, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,source_type,source_id)
);
ALTER TABLE loss_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE loss_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON loss_entries
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS loss_entries_date_idx ON loss_entries(tenant_id,occurred_at DESC);
