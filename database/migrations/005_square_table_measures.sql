-- Lado y capacidad recomendada de mesas cuadradas (issue #37).
ALTER TABLE dining_tables
  ADD COLUMN IF NOT EXISTS width_cm int,
  ADD COLUMN IF NOT EXISTS height_cm int,
  ADD COLUMN IF NOT EXISTS seats_recommended int;

-- Compatibilidad: toda mesa cuadrada existente recibe 80 cm de lado.
UPDATE dining_tables SET width_cm = 80, height_cm = 80, seats_recommended = seats
WHERE shape = 'square' AND width_cm IS NULL;

ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_width_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_width_check
  CHECK (width_cm IS NULL OR (width_cm >= 50 AND width_cm <= 150));
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_height_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_height_check
  CHECK (height_cm IS NULL OR (height_cm >= 50 AND height_cm <= 150));
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_square_equal_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_square_equal_check
  CHECK (width_cm IS NULL OR height_cm IS NULL OR width_cm = height_cm);
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_seats_recommended_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_seats_recommended_check
  CHECK (seats_recommended IS NULL OR (seats_recommended >= 1 AND seats_recommended <= 20));
