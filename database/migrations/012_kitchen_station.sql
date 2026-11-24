ALTER TABLE products ADD COLUMN IF NOT EXISTS kitchen_station text NOT NULL DEFAULT 'kitchen';
ALTER TABLE products ADD CONSTRAINT products_kitchen_station_check CHECK (kitchen_station IN ('kitchen','bar'));
