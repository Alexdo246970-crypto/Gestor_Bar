-- Perfil de cocina (#66): auditoría de cambios de impresora.
CREATE TABLE IF NOT EXISTS kitchen_settings_audit (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  changed_by uuid REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  old_values jsonb,
  new_values jsonb,
  PRIMARY KEY (tenant_id,id)
);

CREATE INDEX IF NOT EXISTS kitchen_settings_audit_tenant_idx
  ON kitchen_settings_audit(tenant_id,changed_at DESC);

ALTER TABLE kitchen_settings_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_settings_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON kitchen_settings_audit;
CREATE POLICY tenant_isolation ON kitchen_settings_audit
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
