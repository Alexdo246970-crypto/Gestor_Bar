ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS package_label text NOT NULL DEFAULT 'unidad';
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS package_size numeric(14,3) NOT NULL DEFAULT 1;
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS package_price_net numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS default_vat_rate numeric(5,2) NOT NULL DEFAULT 0;
UPDATE ingredients SET package_price_net=current_unit_cost*package_size WHERE package_price_net=0 AND current_unit_cost>0;

ALTER TABLE purchases ADD COLUMN IF NOT EXISTS vat_deductible boolean NOT NULL DEFAULT true;
ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS package_count numeric(12,3);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS vat_deductible boolean NOT NULL DEFAULT true;
ALTER TABLE product_allowed_ingredients ADD COLUMN IF NOT EXISTS extra_price_net numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE order_line_modifications ADD COLUMN IF NOT EXISTS unit_price_net numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS unit_cost numeric(12,5) NOT NULL DEFAULT 0;
