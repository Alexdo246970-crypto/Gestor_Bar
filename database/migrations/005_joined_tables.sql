-- Unir mesas contiguas: la mesa resultante es rectangular y ocupa varias casillas del plano.
ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS span_x int NOT NULL DEFAULT 1 CHECK (span_x > 0);
ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS span_y int NOT NULL DEFAULT 1 CHECK (span_y > 0);
-- Pila de uniones (la última al final) para poder separarlas restaurando cada mesa en su sitio.
ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS merged_from jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_shape_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_shape_check CHECK (shape IN ('square','round','bar','rect'));
