-- Las columnas delivery_days, minimum_order y payment_days ya se crean en 009_supplier_terms.sql.
-- Esta migración solo añade la unicidad del nombre de proveedor por tenant (sin distinguir mayúsculas).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM suppliers
    GROUP BY tenant_id, lower(name)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'No se puede crear suppliers_tenant_lower_name_idx: hay proveedores con el mismo nombre (sin distinguir mayúsculas) en un mismo tenant';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_tenant_lower_name_idx
  ON suppliers (tenant_id, lower(name));
