ALTER TABLE tenant_users DROP CONSTRAINT IF EXISTS tenant_users_role_check;
ALTER TABLE tenant_users ADD CONSTRAINT tenant_users_role_check
  CHECK (role IN ('admin','owner','manager','waiter','temporary_waiter','cashier'));

ALTER TABLE order_lines ADD COLUMN created_by uuid REFERENCES users(id);
ALTER TABLE order_lines ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE order_lines ADD COLUMN cancelled_at timestamptz;
ALTER TABLE order_lines ADD COLUMN cancelled_by uuid REFERENCES users(id);
ALTER TABLE order_lines ADD COLUMN cancellation_reason text;

CREATE TABLE audit_events (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  target_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX audit_events_tenant_date_idx ON audit_events(tenant_id,created_at DESC);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
