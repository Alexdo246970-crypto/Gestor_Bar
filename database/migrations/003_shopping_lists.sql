CREATE TABLE IF NOT EXISTS shopping_lists (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  generated_at timestamptz NOT NULL DEFAULT now(), created_by uuid REFERENCES users(id),
  reviewed_at timestamptz, reviewed_by uuid REFERENCES users(id),
  PRIMARY KEY (tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_draft_shopping_list_per_tenant
  ON shopping_lists(tenant_id) WHERE status='draft';
CREATE TABLE IF NOT EXISTS shopping_list_lines (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), shopping_list_id uuid NOT NULL,
  ingredient_id uuid NOT NULL, source text NOT NULL DEFAULT 'stock' CHECK (source IN ('stock','manual')),
  package_count numeric(12,3) NOT NULL CHECK (package_count > 0), quantity_base numeric(14,3) NOT NULL CHECK (quantity_base > 0),
  package_price_net numeric(12,2) NOT NULL CHECK (package_price_net >= 0), vat_rate numeric(5,2) NOT NULL DEFAULT 0 CHECK (vat_rate >= 0),
  checked boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,shopping_list_id,ingredient_id),
  FOREIGN KEY (tenant_id,shopping_list_id) REFERENCES shopping_lists(tenant_id,id),
  FOREIGN KEY (tenant_id,ingredient_id) REFERENCES ingredients(tenant_id,id)
);
ALTER TABLE shopping_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shopping_lists
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE shopping_list_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_list_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shopping_list_lines
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
