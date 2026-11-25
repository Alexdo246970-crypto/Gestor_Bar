-- Unir cualquier mesa: la mesa unida ocupa el espacio de las dos, así que puede superar las medidas de una mesa suelta.
-- Los rangos por forma (redonda, cuadrada, rectangular) los sigue validando la API para las mesas sin unir.
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_width_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_width_check
  CHECK (width_cm IS NULL OR (width_cm >= 50 AND width_cm <= 10000));
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_height_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_height_check
  CHECK (height_cm IS NULL OR (height_cm >= 50 AND height_cm <= 10000));
-- Una mesa unida puede ser rectangular sin ser cuadrada aunque la original lo fuera.
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_square_equal_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_square_equal_check
  CHECK (shape <> 'square' OR width_cm IS NULL OR height_cm IS NULL OR width_cm = height_cm);
ALTER TABLE dining_tables DROP CONSTRAINT IF EXISTS dining_tables_seats_recommended_check;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_seats_recommended_check
  CHECK (seats_recommended IS NULL OR (seats_recommended >= 1 AND seats_recommended <= 200));
