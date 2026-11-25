ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_item_id uuid;
DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT products_stock_item_fk
    FOREIGN KEY (tenant_id,stock_item_id) REFERENCES ingredients(tenant_id,id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS supplier_item_prices (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL,
  ingredient_id uuid NOT NULL,
  package_price_net numeric(12,2) NOT NULL CHECK (package_price_net >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  preferred boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id),
  FOREIGN KEY (tenant_id,ingredient_id) REFERENCES ingredients(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS supplier_item_prices_history_idx ON supplier_item_prices(tenant_id,ingredient_id,effective_from DESC);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_item_prices_preferred_idx ON supplier_item_prices(tenant_id,ingredient_id) WHERE preferred;

INSERT INTO supplier_item_prices(tenant_id,supplier_id,ingredient_id,package_price_net,preferred)
SELECT tenant_id,supplier_id,id,package_price_net,true FROM ingredients WHERE supplier_id IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE supplier_item_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_item_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supplier_item_prices
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
