-- Cabecera completa, líneas libres y pagos de facturas (issue #59).
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS invoice_date date,
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS paid_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notes text;
UPDATE purchases SET
  invoice_date = (purchased_at AT TIME ZONE 'Europe/Madrid')::date,
  due_date = (purchased_at AT TIME ZONE 'Europe/Madrid')::date + INTERVAL '30 days'
WHERE invoice_date IS NULL;
ALTER TABLE purchases ALTER COLUMN invoice_date SET DEFAULT (now() AT TIME ZONE 'Europe/Madrid')::date;
ALTER TABLE purchases ALTER COLUMN invoice_date SET NOT NULL;
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_payment_status_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_payment_status_check
  CHECK (payment_status IN ('pending','partial','paid'));
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_paid_amount_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_paid_amount_check
  CHECK (paid_amount >= 0 AND paid_amount <= gross_total);

ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE purchase_lines ALTER COLUMN ingredient_id DROP NOT NULL;
ALTER TABLE purchase_lines DROP CONSTRAINT IF EXISTS purchase_lines_item_check;
ALTER TABLE purchase_lines ADD CONSTRAINT purchase_lines_item_check
  CHECK ((ingredient_id IS NOT NULL AND description IS NULL) OR (ingredient_id IS NULL AND length(btrim(description)) > 0));

CREATE TABLE IF NOT EXISTS purchase_payments (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL, amount numeric(12,2) NOT NULL CHECK (amount > 0),
  method text, account text NOT NULL DEFAULT 'cash' CHECK (account IN ('cash','bank')),
  reference text, paid_at timestamptz NOT NULL DEFAULT now(), created_by uuid REFERENCES users(id),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,purchase_id) REFERENCES purchases(tenant_id,id)
);
ALTER TABLE purchase_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_payments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS purchase_payments_purchase_idx ON purchase_payments(tenant_id,purchase_id);
CREATE INDEX IF NOT EXISTS purchases_invoice_date_idx ON purchases(tenant_id,invoice_date DESC);
