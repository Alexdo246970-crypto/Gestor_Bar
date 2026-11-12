ALTER TABLE orders ADD COLUMN IF NOT EXISTS kitchen_status text NOT NULL DEFAULT 'received'
  CHECK (kitchen_status IN ('received','preparing','ready'));
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS kitchen_status text NOT NULL DEFAULT 'received'
  CHECK (kitchen_status IN ('received','preparing','ready'));
ALTER TABLE orders ALTER COLUMN opened_by DROP NOT NULL;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_channel_check;
ALTER TABLE orders ADD CONSTRAINT orders_channel_check CHECK (channel IN ('table','counter','delivery','qr'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email text;
ALTER TABLE tenant_users DROP CONSTRAINT IF EXISTS tenant_users_role_check;
ALTER TABLE tenant_users ADD CONSTRAINT tenant_users_role_check CHECK (role IN ('admin','manager','waiter','cashier','kitchen'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS qr_token text NOT NULL DEFAULT encode(gen_random_bytes(24),'hex');
CREATE UNIQUE INDEX IF NOT EXISTS dining_tables_qr_token_idx ON dining_tables(qr_token);
CREATE TABLE IF NOT EXISTS tenant_kitchen_settings (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id), printer_name text, printer_mode text NOT NULL DEFAULT 'browser'
   CHECK (printer_mode IN ('browser','network')), printer_host text, printer_port integer NOT NULL DEFAULT 9100,
 ticket_autoprint boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_kitchen_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_kitchen_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_kitchen_settings USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
 WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
