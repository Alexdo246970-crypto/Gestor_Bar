-- Amortizaciones manuales para el estado de resultados (issue #63).
CREATE TABLE IF NOT EXISTS amortizations (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL, monthly_amount numeric(12,2) NOT NULL CHECK (monthly_amount > 0),
  start_month date NOT NULL, end_month date, active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
ALTER TABLE amortizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE amortizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON amortizations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
