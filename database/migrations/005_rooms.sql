-- Entidad sala: sustituye las zonas escritas a mano (issue #40).
CREATE TABLE IF NOT EXISTS rooms (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL, width_cm int NOT NULL DEFAULT 800 CHECK (width_cm BETWEEN 100 AND 10000),
  height_cm int NOT NULL DEFAULT 500 CHECK (height_cm BETWEEN 100 AND 10000),
  sort_order int NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,lower(name))
);
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rooms
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS room_id uuid;
-- Traspaso de las zonas existentes a salas, sin perder mesas ni comandas.
INSERT INTO rooms (tenant_id,name) SELECT DISTINCT tenant_id, zone FROM dining_tables
  WHERE active AND zone IS NOT NULL ON CONFLICT (tenant_id,lower(name)) DO NOTHING;
UPDATE dining_tables SET room_id = (SELECT r.id FROM rooms r
  WHERE r.tenant_id=dining_tables.tenant_id AND lower(r.name)=lower(dining_tables.zone) LIMIT 1)
  WHERE room_id IS NULL;
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_room_fk;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_room_fk
  FOREIGN KEY (tenant_id,room_id) REFERENCES rooms(tenant_id,id);
CREATE INDEX IF NOT EXISTS dining_tables_room_idx ON dining_tables(tenant_id,room_id) WHERE active;
