-- Medidas y capacidad recomendada de mesas redondas (issue #36).
ALTER TABLE dining_tables
  ADD COLUMN IF NOT EXISTS diameter_cm numeric(6,1),
  ADD COLUMN IF NOT EXISTS seats_recommended int;

-- Compatibilidad: 90 cm hasta 4 plazas, 120 cm por encima; nunca sin medida.
UPDATE dining_tables SET
  diameter_cm = CASE WHEN seats <= 4 THEN 90 ELSE 120 END,
  seats_recommended = CASE WHEN seats <= 4 THEN 4 WHEN seats <= 8 THEN 8 ELSE 10 END
WHERE shape = 'round' AND diameter_cm IS NULL;

ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_diameter_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_diameter_check
  CHECK (diameter_cm IS NULL OR (diameter_cm >= 50 AND diameter_cm <= 200));
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_seats_recommended_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_seats_recommended_check
  CHECK (seats_recommended IS NULL OR (seats_recommended >= 1 AND seats_recommended <= 20));
