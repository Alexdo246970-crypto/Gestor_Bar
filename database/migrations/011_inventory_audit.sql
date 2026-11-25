ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS adjustment_reason text;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS count_session_id uuid;
UPDATE stock_movements SET adjustment_reason='otro',note=source_type WHERE movement_type='adjustment' AND adjustment_reason IS NULL;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_adjustment_reason_check
  CHECK (movement_type <> 'adjustment' OR adjustment_reason IN ('merma','rotura','caducidad','conteo','otro'));

CREATE TABLE IF NOT EXISTS inventory_count_sessions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  note text,
  PRIMARY KEY (tenant_id,id)
);
DO $$ BEGIN
  ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_count_session_fk
    FOREIGN KEY (tenant_id,count_session_id) REFERENCES inventory_count_sessions(tenant_id,id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS stock_movements_count_session_idx ON stock_movements(tenant_id,count_session_id) WHERE count_session_id IS NOT NULL;
ALTER TABLE inventory_count_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_count_sessions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
