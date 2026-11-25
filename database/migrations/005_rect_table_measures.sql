-- Forma rectangular, medidas, lados usados y capacidad recomendada (issue #38).
ALTER TABLE dining_tables
  ADD COLUMN IF NOT EXISTS width_cm int,
  ADD COLUMN IF NOT EXISTS height_cm int,
  ADD COLUMN IF NOT EXISTS sides_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS seats_recommended int;

ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_shape_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_shape_check
  CHECK (shape IN ('square', 'round', 'bar', 'rect'));

-- La barra existente pasa a rectangular estrecha sin tocar sus comandas.
UPDATE dining_tables SET
  shape = 'rect', width_cm = 120, height_cm = 60,
  sides_used = '["long1"]'::jsonb, seats_recommended = 2
WHERE shape = 'bar';

UPDATE dining_tables SET
  width_cm = 120, height_cm = 80,
  sides_used = '["long1","long2"]'::jsonb,
  seats_recommended = 4
WHERE shape = 'rect' AND width_cm IS NULL;

ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_width_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_width_check
  CHECK (width_cm IS NULL OR (width_cm >= 80 AND width_cm <= 240));
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_height_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_height_check
  CHECK (height_cm IS NULL OR (height_cm >= 60 AND height_cm <= 120));
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_sides_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_sides_check
  CHECK (jsonb_typeof(sides_used) = 'array');
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_seats_recommended_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_seats_recommended_check
  CHECK (seats_recommended IS NULL OR (seats_recommended >= 1 AND seats_recommended <= 20));
