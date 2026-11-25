ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS received_quantity numeric(14,3) NOT NULL DEFAULT 0;
ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS receipt_note text;
UPDATE purchase_lines pl SET received_quantity=pl.quantity
FROM purchases p WHERE p.tenant_id=pl.tenant_id AND p.id=pl.purchase_id AND p.status='received' AND pl.received_quantity=0;
ALTER TABLE purchase_lines ADD CONSTRAINT purchase_lines_received_quantity_check CHECK (received_quantity >= 0 AND received_quantity <= quantity);

ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_status_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_status_check CHECK (status IN ('draft','partially_received','received','void'));
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS received_net_total numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS received_vat_total numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS received_gross_total numeric(12,2) NOT NULL DEFAULT 0;
UPDATE purchases SET received_net_total=net_total,received_vat_total=vat_total,received_gross_total=gross_total WHERE status='received';
