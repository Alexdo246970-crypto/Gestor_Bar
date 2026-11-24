-- Medidas y capacidad recomendada por forma de mesa (issues #36, #37, #38).
ALTER TABLE dining_tables
  ADD COLUMN IF NOT EXISTS diameter_cm numeric(6,1),
  ADD COLUMN IF NOT EXISTS width_cm int,
  ADD COLUMN IF NOT EXISTS height_cm int,
  ADD COLUMN IF NOT EXISTS sides_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS seats_recommended int;

-- Compatibilidad: mesas ya creadas reciben una medida por defecto según su forma.
UPDATE dining_tables SET
  diameter_cm = CASE WHEN shape='round' THEN CASE WHEN seats <= 4 THEN 90 ELSE 120 END END,
  width_cm = CASE WHEN shape='square' THEN 80 WHEN shape='rect' THEN 120 WHEN shape='bar' THEN 60 END,
  height_cm = CASE WHEN shape='square' THEN 80 WHEN shape='rect' THEN 80 WHEN shape='bar' THEN 80 END,
  sides_used = CASE WHEN shape IN ('rect','bar') THEN '["long1","long2"]'::jsonb ELSE '[]'::jsonb END,
  seats_recommended = seats
WHERE diameter_cm IS NULL AND width_cm IS NULL;

ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_diameter_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_diameter_check
  CHECK (diameter_cm IS NULL OR (diameter_cm >= 50 AND diameter_cm <= 200));
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_width_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_width_check
  CHECK (width_cm IS NULL OR (width_cm >= 50 AND width_cm <= 240));
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_height_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_height_check
  CHECK (height_cm IS NULL OR (height_cm >= 60 AND height_cm <= 150));
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_seats_recommended_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_seats_recommended_check
  CHECK (seats_recommended IS NULL OR (seats_recommended >= 1 AND seats_recommended <= 20));

-- La barra se considera una rectangular estrecha (solo #38).
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_shape_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_shape_check
  CHECK (shape IN ('square','round','bar','rect'));
UPDATE dining_tables SET shape='rect' WHERE shape='bar';
