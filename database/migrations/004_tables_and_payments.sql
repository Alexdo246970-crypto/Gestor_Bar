-- Mapa de mesas vinculado a las comandas y detalle de cobro (tarjeta TPV / efectivo).
CREATE TABLE IF NOT EXISTS dining_tables (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  label text NOT NULL, zone text NOT NULL DEFAULT 'Salón',
  seats int NOT NULL DEFAULT 4 CHECK (seats > 0),
  shape text NOT NULL DEFAULT 'square' CHECK (shape IN ('square','round','bar')),
  pos_x int NOT NULL DEFAULT 0 CHECK (pos_x >= 0), pos_y int NOT NULL DEFAULT 0 CHECK (pos_y >= 0),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS dining_tables_label_active_idx ON dining_tables(tenant_id,lower(label)) WHERE active;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_id uuid;
ALTER TABLE orders ADD CONSTRAINT orders_table_fk FOREIGN KEY (tenant_id,table_id) REFERENCES dining_tables(tenant_id,id);
-- Una mesa solo puede tener una comanda activa a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_order_per_table ON orders(tenant_id,table_id)
  WHERE table_id IS NOT NULL AND status IN ('open','sent');

ALTER TABLE payments ADD COLUMN IF NOT EXISTS cash_tendered numeric(12,2) CHECK (cash_tendered IS NULL OR cash_tendered >= 0);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS change_given numeric(12,2) CHECK (change_given IS NULL OR change_given >= 0);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_reference text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);

ALTER TABLE dining_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE dining_tables FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dining_tables
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Precios de carta introducidos con IVA incluido: guardar la base con 4 decimales evita desfases de céntimos.
ALTER TABLE products ALTER COLUMN price_net TYPE numeric(12,4);
