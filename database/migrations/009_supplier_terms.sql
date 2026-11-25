ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS delivery_days text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS minimum_order numeric(12,2) CHECK (minimum_order IS NULL OR minimum_order >= 0);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_days integer CHECK (payment_days IS NULL OR payment_days >= 0);
