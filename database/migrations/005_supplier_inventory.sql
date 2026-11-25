ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS supplier_id uuid;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms text;
DO $$ BEGIN
  ALTER TABLE ingredients ADD CONSTRAINT ingredients_supplier_fk
    FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS ingredients_supplier_idx ON ingredients(tenant_id, supplier_id) WHERE active;
