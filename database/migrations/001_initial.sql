CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE,
  name text NOT NULL, timezone text NOT NULL DEFAULT 'Europe/Madrid',
  currency char(3) NOT NULL DEFAULT 'EUR', active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL,
  password_hash text NOT NULL, full_name text NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (email)
);
CREATE TABLE tenant_users (
  tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin','manager','waiter','cashier')),
  active boolean NOT NULL DEFAULT true, PRIMARY KEY (tenant_id,user_id)
);
CREATE TABLE categories (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL, sort_order int NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,name)
);
CREATE TABLE products (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  category_id uuid, name text NOT NULL, description text,
  price_net numeric(12,2) NOT NULL CHECK (price_net >= 0), vat_rate numeric(5,2) NOT NULL CHECK (vat_rate >= 0),
  active boolean NOT NULL DEFAULT true, available_from date, available_to date,
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,category_id) REFERENCES categories(tenant_id,id)
);
CREATE TABLE ingredients (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL, unit text NOT NULL, current_stock numeric(14,3) NOT NULL DEFAULT 0,
  min_stock numeric(14,3) NOT NULL DEFAULT 0, current_unit_cost numeric(12,5) NOT NULL DEFAULT 0 CHECK (current_unit_cost >= 0), active boolean NOT NULL DEFAULT true,
  package_label text NOT NULL DEFAULT 'unidad', package_size numeric(14,3) NOT NULL DEFAULT 1 CHECK (package_size > 0),
  package_price_net numeric(12,2) NOT NULL DEFAULT 0 CHECK (package_price_net >= 0), default_vat_rate numeric(5,2) NOT NULL DEFAULT 0 CHECK (default_vat_rate >= 0),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,name)
);
CREATE TABLE recipes (
  tenant_id uuid NOT NULL, product_id uuid NOT NULL, ingredient_id uuid NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (tenant_id,product_id,ingredient_id),
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id),
  FOREIGN KEY (tenant_id,ingredient_id) REFERENCES ingredients(tenant_id,id)
);
CREATE TABLE product_allowed_ingredients (
  tenant_id uuid NOT NULL, product_id uuid NOT NULL, ingredient_id uuid NOT NULL,
  extra_price_net numeric(12,2) NOT NULL DEFAULT 0 CHECK (extra_price_net >= 0),
  PRIMARY KEY (tenant_id,product_id,ingredient_id),
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id),
  FOREIGN KEY (tenant_id,ingredient_id) REFERENCES ingredients(tenant_id,id)
);
CREATE TABLE suppliers (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL, tax_id text, email text, phone text, address text, active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id,id)
);
CREATE TABLE purchases (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(), supplier_id uuid,
  invoice_number text, purchased_at timestamptz NOT NULL, status text NOT NULL CHECK (status IN ('draft','received','void')),
  payment_method text, vat_deductible boolean NOT NULL DEFAULT true, net_total numeric(12,2) NOT NULL DEFAULT 0, vat_total numeric(12,2) NOT NULL DEFAULT 0,
  gross_total numeric(12,2) NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id)
);
CREATE TABLE purchase_lines (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), purchase_id uuid NOT NULL,
  ingredient_id uuid NOT NULL, quantity numeric(14,3) NOT NULL CHECK (quantity > 0), package_count numeric(12,3),
  unit_price_net numeric(12,4) NOT NULL CHECK (unit_price_net >= 0), vat_rate numeric(5,2) NOT NULL CHECK (vat_rate >= 0),
  line_net numeric(12,2) NOT NULL, line_vat numeric(12,2) NOT NULL, line_gross numeric(12,2) NOT NULL,
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,purchase_id) REFERENCES purchases(tenant_id,id),
  FOREIGN KEY (tenant_id,ingredient_id) REFERENCES ingredients(tenant_id,id)
);
CREATE TABLE daily_menus (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  menu_date date NOT NULL, name text NOT NULL, price_net numeric(12,2) NOT NULL CHECK (price_net >= 0),
  vat_rate numeric(5,2) NOT NULL CHECK (vat_rate >= 0), active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,menu_date,name)
);
CREATE TABLE daily_menu_items (
  tenant_id uuid NOT NULL, daily_menu_id uuid NOT NULL, product_id uuid NOT NULL, sort_order int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id,daily_menu_id,product_id),
  FOREIGN KEY (tenant_id,daily_menu_id) REFERENCES daily_menus(tenant_id,id),
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE orders (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(), order_number bigserial NOT NULL,
  status text NOT NULL CHECK (status IN ('open','sent','paid','cancelled')),
  channel text NOT NULL DEFAULT 'table' CHECK (channel IN ('table','counter','delivery')),
  table_label text, opened_by uuid NOT NULL REFERENCES users(id), opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz, net_total numeric(12,2) NOT NULL DEFAULT 0, vat_total numeric(12,2) NOT NULL DEFAULT 0,
  gross_total numeric(12,2) NOT NULL DEFAULT 0, stock_deducted_at timestamptz,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,order_number)
);
CREATE TABLE order_lines (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), order_id uuid NOT NULL,
  product_id uuid NOT NULL, product_name text NOT NULL, quantity numeric(10,2) NOT NULL CHECK (quantity > 0),
  unit_net numeric(12,2) NOT NULL, vat_rate numeric(5,2) NOT NULL,
  line_net numeric(12,2) NOT NULL, line_vat numeric(12,2) NOT NULL, line_gross numeric(12,2) NOT NULL,
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,order_id) REFERENCES orders(tenant_id,id),
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE order_line_modifications (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), order_line_id uuid NOT NULL,
  ingredient_id uuid NOT NULL, action text NOT NULL CHECK (action IN ('add','remove')),
  quantity_per_unit numeric(14,3) NOT NULL CHECK (quantity_per_unit > 0),
  unit_price_net numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price_net >= 0),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,order_line_id) REFERENCES order_lines(tenant_id,id),
  FOREIGN KEY (tenant_id,ingredient_id) REFERENCES ingredients(tenant_id,id)
);
CREATE TABLE payments (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), order_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('cash','card','other')), amount numeric(12,2) NOT NULL CHECK (amount > 0),
  paid_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
CREATE TABLE stock_movements (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(), ingredient_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(), movement_type text NOT NULL
    CHECK (movement_type IN ('purchase','sale','adjustment','waste','reversal')),
  quantity_delta numeric(14,3) NOT NULL CHECK (quantity_delta <> 0), unit_cost numeric(12,5) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0), source_type text, source_id uuid,
  created_by uuid REFERENCES users(id), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,ingredient_id) REFERENCES ingredients(tenant_id,id)
);
CREATE TABLE cash_closures (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(), business_date date NOT NULL,
  opened_at timestamptz NOT NULL, closed_at timestamptz, opening_cash numeric(12,2) NOT NULL DEFAULT 0,
  expected_cash numeric(12,2) NOT NULL DEFAULT 0, counted_cash numeric(12,2), cash_difference numeric(12,2),
  closed_by uuid REFERENCES users(id), notes text, PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,business_date)
);
CREATE TABLE expenses (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  expense_date date NOT NULL, category text NOT NULL, description text NOT NULL,
  net_amount numeric(12,2) NOT NULL CHECK (net_amount >= 0), vat_rate numeric(5,2) NOT NULL DEFAULT 0 CHECK (vat_rate >= 0),
  vat_amount numeric(12,2) NOT NULL DEFAULT 0, vat_deductible boolean NOT NULL DEFAULT true, gross_amount numeric(12,2) NOT NULL CHECK (gross_amount >= 0),
  payment_method text, created_by uuid REFERENCES users(id), PRIMARY KEY (tenant_id,id)
);
CREATE TABLE budgets (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  budget_month date NOT NULL, category text NOT NULL, planned_amount numeric(12,2) NOT NULL CHECK (planned_amount >= 0),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,budget_month,category)
);
CREATE TABLE sessions (
  sid text PRIMARY KEY, sess jsonb NOT NULL, expire timestamptz NOT NULL
);
CREATE INDEX sessions_expire_idx ON sessions(expire);
CREATE INDEX orders_tenant_status_idx ON orders(tenant_id,status,opened_at);
CREATE INDEX payments_tenant_paid_idx ON payments(tenant_id,paid_at);
CREATE INDEX stock_tenant_ingredient_idx ON stock_movements(tenant_id,ingredient_id,occurred_at);
CREATE INDEX purchases_tenant_date_idx ON purchases(tenant_id,purchased_at);

-- Tenant-scoped tables: RLS is defense in depth. The API sets app.tenant_id per transaction.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_users','categories','products','ingredients','recipes','product_allowed_ingredients','suppliers','purchases',
    'purchase_lines','daily_menus','daily_menu_items','orders','order_lines','order_line_modifications','payments','stock_movements','cash_closures','expenses','budgets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
