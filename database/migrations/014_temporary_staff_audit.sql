CREATE TABLE IF NOT EXISTS staff_account_audit (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('created','reactivated','revoked','sessions_revoked')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
ALTER TABLE staff_account_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_account_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_account_audit
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
