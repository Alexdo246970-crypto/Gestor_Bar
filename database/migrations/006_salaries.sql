-- Plantilla y nóminas mensuales (issue #60).
CREATE TABLE IF NOT EXISTS employees (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL, tax_id text, position text,
  hired_at date NOT NULL DEFAULT (now() AT TIME ZONE 'Europe/Madrid')::date, left_at date,
  user_id uuid, payment_account text, active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id,id)
);
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employees
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS salary_entries (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL, month date NOT NULL,
  gross numeric(12,2) NOT NULL CHECK (gross > 0),
  social_security_company numeric(12,2) NOT NULL DEFAULT 0 CHECK (social_security_company >= 0),
  social_security_worker numeric(12,2) NOT NULL DEFAULT 0 CHECK (social_security_worker >= 0),
  irpf_withheld numeric(12,2) NOT NULL DEFAULT 0 CHECK (irpf_withheld >= 0),
  other_concepts numeric(12,2) NOT NULL DEFAULT 0 CHECK (other_concepts >= 0),
  net numeric(12,2) NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','paid','void')),
  payment_date date, paid_at date, notes text,
  confirmed_at timestamptz, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,employee_id) REFERENCES employees(tenant_id,id)
);
ALTER TABLE salary_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON salary_entries
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS salary_entries_month_idx ON salary_entries(tenant_id,month DESC);
