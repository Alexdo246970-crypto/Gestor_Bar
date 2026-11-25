ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS qr_last_order_at timestamptz;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('open','pending_approval','sent','paid','cancelled'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_status_token text;
CREATE UNIQUE INDEX IF NOT EXISTS orders_qr_status_token_idx
  ON orders(qr_status_token) WHERE qr_status_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS tenant_qr_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  approval_required boolean NOT NULL DEFAULT false,
  max_order_lines integer NOT NULL DEFAULT 20 CHECK (max_order_lines BETWEEN 1 AND 20),
  cooldown_seconds integer NOT NULL DEFAULT 120 CHECK (cooldown_seconds BETWEEN 0 AND 3600),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_qr_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_qr_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_qr_settings;
CREATE POLICY tenant_isolation ON tenant_qr_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
