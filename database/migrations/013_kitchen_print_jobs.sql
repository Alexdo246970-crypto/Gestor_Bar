ALTER TABLE tenant_kitchen_settings ADD COLUMN IF NOT EXISTS ticket_width integer NOT NULL DEFAULT 80 CHECK (ticket_width IN (58,80));

CREATE TABLE IF NOT EXISTS kitchen_print_jobs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  round_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','printed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  printed_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,order_id,round_key),
  FOREIGN KEY (tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
ALTER TABLE kitchen_print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_print_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kitchen_print_jobs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
