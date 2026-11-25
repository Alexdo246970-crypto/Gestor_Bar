-- Configuración fiscal, periodos de liquidación y otros impuestos (issue #61).
CREATE TABLE IF NOT EXISTS tax_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  frequency text NOT NULL DEFAULT 'quarterly' CHECK (frequency IN ('monthly','quarterly')),
  vat_regime text NOT NULL DEFAULT 'general', due_day int NOT NULL DEFAULT 20 CHECK (due_day BETWEEN 1 AND 28),
  threshold_pct numeric(5,2) NOT NULL DEFAULT 3 CHECK (threshold_pct >= 0)
);
ALTER TABLE tax_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS tax_periods (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  period_key text NOT NULL, start_date date NOT NULL, end_date date NOT NULL, due_date date NOT NULL,
  output_vat numeric(12,2) NOT NULL DEFAULT 0, input_vat numeric(12,2) NOT NULL DEFAULT 0,
  rounding_adjustment numeric(12,2) NOT NULL DEFAULT 0, result numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','filed','paid')),
  filed_at timestamptz, paid_at date, notes text, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,period_key)
);
ALTER TABLE tax_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_periods
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS tax_period_entries (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL, source_type text NOT NULL CHECK (source_type IN ('order','purchase','expense')),
  source_id uuid NOT NULL, operation_date date NOT NULL, amount_net numeric(12,2) NOT NULL, vat numeric(12,2) NOT NULL,
  description text, PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,period_id) REFERENCES tax_periods(tenant_id,id),
  UNIQUE (tenant_id,period_id,source_type,source_id)
);
ALTER TABLE tax_period_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_period_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_period_entries
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS other_taxes (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL, amount numeric(12,2) NOT NULL CHECK (amount > 0), period text, due_date date,
  reference text, notes text, paid boolean NOT NULL DEFAULT false, paid_at timestamptz, created_by uuid REFERENCES users(id),
  PRIMARY KEY (tenant_id,id)
);
ALTER TABLE other_taxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE other_taxes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON other_taxes
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS tax_periods_due_idx ON tax_periods(tenant_id,due_date);
