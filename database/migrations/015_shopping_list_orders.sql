CREATE TABLE IF NOT EXISTS shopping_list_purchases (
  tenant_id uuid NOT NULL,
  shopping_list_id uuid NOT NULL,
  purchase_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,shopping_list_id,purchase_id),
  UNIQUE (tenant_id,purchase_id),
  FOREIGN KEY (tenant_id,shopping_list_id) REFERENCES shopping_lists(tenant_id,id),
  FOREIGN KEY (tenant_id,purchase_id) REFERENCES purchases(tenant_id,id)
);
ALTER TABLE shopping_list_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_list_purchases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shopping_list_purchases
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
