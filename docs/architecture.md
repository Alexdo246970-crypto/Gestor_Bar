# Arquitectura y modelo funcional

## Componentes

```mermaid
flowchart LR
  SPA[React SPA / TPV] -->|REST + cookie| API[NestJS API]
  SPA <-->|WebSocket futuro: cocina| API
  API --> PG[(PostgreSQL 16)]
  API --> OBJ[Almacenamiento de facturas futuro]
```

La API está organizada por autenticación, catálogo, pedidos, inventario, compras y finanzas. Las operaciones de escritura relacionadas se ejecutan en una única transacción PostgreSQL. El frontend nunca calcula importes como fuente de verdad: el servidor obtiene producto, precio e IVA del catálogo.

## ER resumido

```mermaid
erDiagram
  TENANTS ||--o{ TENANT_USERS : tiene
  USERS ||--o{ TENANT_USERS : pertenece
  TENANTS ||--o{ CATEGORIES : define
  CATEGORIES ||--o{ PRODUCTS : agrupa
  PRODUCTS ||--o{ RECIPES : requiere
  INGREDIENTS ||--o{ RECIPES : ingrediente
  TENANTS ||--o{ ORDERS : recibe
  ORDERS ||--|{ ORDER_LINES : contiene
  ORDER_LINES ||--o{ ORDER_LINE_MODIFICATIONS : personaliza
  PRODUCTS ||--o{ ORDER_LINES : vendido
  ORDERS ||--o{ PAYMENTS : cobra
  INGREDIENTS ||--o{ STOCK_MOVEMENTS : registra
  TENANTS ||--o{ SUPPLIERS : contrata
  SUPPLIERS ||--o{ PURCHASES : factura
  PURCHASES ||--|{ PURCHASE_LINES : incluye
  CASH_CLOSURES }o--|| TENANTS : cierra
```

Las tablas con datos de local tienen `tenant_id`; la mayor parte usa PK compuesta `(tenant_id,id)` y las relaciones FK compuestas para impedir asociaciones entre locales. `users` es identidad global y `tenant_users` determina pertenencia y rol. La sesión selecciona el local de trabajo. `product_allowed_ingredients` define qué extras se pueden añadir a cada plato; `order_line_modifications` registra los ingredientes añadidos o retirados en una línea y permite que el cierre calcule el consumo real ajustado.

## Aislamiento y autorización

1. `POST /auth/login` recibe `tenant` (slug), email y contraseña. Se busca el tenant y se valida el usuario miembro dentro del contexto RLS.
2. Se crea una sesión server-side en PostgreSQL y se envía su identificador en cookie HttpOnly. No se acepta el `tenant_id` enviado por el cliente para autorizar consultas.
3. Cada controlador verifica rol; `DbService.tenant()` abre transacción, fija `app.tenant_id` con `SET LOCAL` y ejecuta las operaciones. RLS añade defensa si una consulta olvida filtrar por tenant.
4. En producción usar TLS, secreto de sesión aleatorio, límites de intentos, rotación/expiración de sesiones, CSRF apropiado al despliegue y secretos fuera del repositorio.

## Descuento de stock

El TPV abre pedido, agrega líneas y lo envía. Antes de enviarlo, cada línea permite cambiar unidades, quitar el plato o personalizar la receta: retirar ingredientes de la receta base y añadir extras permitidos para ese producto. Cada extra tiene un recargo neto configurado en `product_allowed_ingredients`; el servidor valida que sea compatible y calcula precio e IVA, ignorando cualquier precio que enviase el cliente. `POST /orders/:id/lines` persiste la personalización con la línea. Tras cobrar el total, `OrdersController` bloquea el pedido (`FOR UPDATE`), valida pagos, calcula consumo base menos ingredientes retirados más ingredientes añadidos, y descuenta las existencias. Por cada ingrediente inserta un movimiento `sale`; marca `stock_deducted_at` y `status=paid`. La transacción revierte todo si falta stock. El bloqueo y la marca de descuento evitan procesamiento doble concurrente. Una anulación debe insertar movimientos `reversal` compensatorios, nunca borrar movimientos previos.

La lista de compra se genera desde ingredientes cuyo stock está por debajo del mínimo. Calcula paquetes completos usando el contenido y precio configurados, persiste un borrador por tenant y conserva las líneas manuales al recalcular. El gerente puede cambiar cantidades, añadir o quitar ingredientes y aprobar la propuesta. Aprobarla la marca como revisada; el servicio aún no envía pedidos a proveedores.

La interfaz de comanda inicial está en modo MVP: agrupa localmente la selección y la envía al backend al enviar a cocina. Para producción, persistir cambios de línea inmediatamente para recuperación ante pérdida de conexión, y publicar eventos transaccionales de cocina mediante outbox/WebSocket.

## Mesas y cobro

`dining_tables` guarda cada mesa con su zona (Salón, Terraza, Barra…), plazas, forma y posición en una cuadrícula del plano. `orders.table_id` vincula la comanda con su mesa y un índice único parcial garantiza una sola comanda activa (`open`/`sent`) por mesa: al abrir una comanda sobre una mesa ocupada, la API devuelve la existente y las nuevas líneas se suman a ella. El mapa muestra cada mesa como libre, comanda sin enviar, en cocina o con cobro parcial. Los pagos aceptan dos formas: tarjeta (datáfono TPV) y efectivo, guardando efectivo entregado y cambio; se pueden dividir en varios pagos. Al completar el total la comanda pasa a `paid` y la mesa queda libre.

### Referencia única de formas, medidas y capacidad (#15)

Tabla de referencia del plano. Las medidas son centímetros enteros; la capacidad es **recomendada** y se puede sobrescribir con aviso cuando se desvía más de 2 plazas.

| Forma | Medidas admitidas | Capacidad recomendada | Dibujo |
|---|---|---|---|
| Redonda | Diámetro 50-200 cm (catálogo 70/90/120/150; precisión 0,5 cm) | 70→3, 90→4, 120→8, 150→10 | Círculo de diámetro `diameter_cm` |
| Cuadrada | Lado 50-150 cm (catálogo 70/80/90/100/120) | 70→2, 80→4, 90→4, 100→6, 120→8 | Cuadrado de `width_cm = height_cm` |
| Rectangular | Ancho 80-240 cm, alto 60-120 cm | 60 cm lineales por comensal en los lados largos + 1 por lado corto | Rectángulo `width_cm × height_cm` |
| Barra | Rectángulo estrecho de 60 cm de alto | 1 por taburete | Rectángulo de un lado |

Regla común: 60 cm lineales por comensal, con margen para sillas. Capacidad mínima 1 y máxima 20. La rotación se trata por separado; no cambia la capacidad.

Escala de dibujo: `px = cm × 2` al 100 %, con zoom del 50-300 % y ajuste al ancho de la sala. Separación mínima entre mesas: 40 cm; un solapamiento se señala visualmente pero no bloquea la edición. Una unión se dibuja como una envolvente única y su capacidad es la suma de las mesas que la forman.

Las issues `#36`, `#37` y `#38` son la configuración/validación de cada forma; `#11`, `#12` y `#13` son el diseño visual; `#42` aplica la escala; `#14` define las uniones. Se mantienen como sub-tareas y se cierran al implementarlas, no se fusionan.
### Mapa de mesas en tiempo real (#16)

El plano mantiene los cuatro estados y la leyenda, y recibe los cambios de comanda por SSE: `GET /api/tables/events` emite `tables-changed` cada 5 s con la sesión de la cookie; el cliente recarga `GET /api/tables` al recibirlo. El polling de 30 s queda como respaldo si se cierra la conexión. En pantallas pequeñas el plano se sustituye por una lista de mesas con el mismo estado y el importe pendiente; las acciones táctiles usan botones grandes y el modo edición sigue restringido a `admin`/`manager`.

## Finanzas

`GET /reports/daily` consulta pedidos pagados por fecha de cierre local, pagos por fecha local, facturas de proveedores recibidas y gastos operativos. Devuelve coste neto y bruto por proveedor, IVA de compra marcado como deducible, IVA deducible de gastos, IVA repercutido, estimación de liquidación, consumo de ingredientes, margen bruto, resultado operativo y ejecución de presupuestos. Cada ingrediente guarda formato (por ejemplo, pack de seis briks), cantidad base por paquete y precio neto por paquete. La recepción convierte paquetes a cantidades de inventario y actualiza el coste medio ponderado; los movimientos de venta guardan el coste aplicado. La fecha de negocio respeta `tenants.timezone`. Las líneas conservan precio e IVA históricos aunque cambie el catálogo. La liquidación de IVA es orientativa y debe verificarse con facturas y normativa.

### Libro de cuentas (#30)

`ledger_entries` es el registro único: fecha de operación, tipo (`income`/`expense`), categoría, cuenta (`cash`/`bank`), base, IVA y total, con `source_type`/`source_id` y un índice único parcial que evita duplicar apuntes al reintentar. Cobrar una comanda genera un ingreso `ventas` con los totales históricos de la orden; recibir una compra genera un gasto `compras` con el IVA solo si es deducible. Los apuntes manuales exigen categoría, fecha e importe positivo y guardan el usuario. `GET /api/ledger?from=&to=&category=&account=` devuelve el detalle paginado, totales por tipo y desglose por categoría; el saldo del periodo es ingresos menos gastos con IVA. Consultan `admin`, `manager` y `cashier`; escriben `admin` y `manager`.

### Resumen financiero (#31)

`GET /api/reports/daily` acepta `date` con `period` (`day`, `week`, `month`, `year`; por defecto el mes en curso) o un rango libre `from`+`to` en formato `YYYY-MM-DD`. El rango exige ambas fechas, `from <= to` y un máximo de 2 años; cualquier otro caso devuelve 400 con un mensaje concreto. Todas las fechas de operación usan `tenants.timezone`. La respuesta mantiene los KPIs y desgloses anteriores (ventas, cobros, compras por proveedor, coste de ingredientes, gastos por categoría, presupuestos y liquidación estimada de IVA) y añade `kpis` y `comparison`: el periodo anterior tiene exactamente la misma duración y cada KPI muestra valor actual, anterior, variación absoluta en euros y variación porcentual (null cuando el anterior es 0, sin divisiones por cero). El resultado neto distingue margen bruto (ventas netas − consumo valorado de ingredientes), resultado operativo (margen bruto − gastos operativos − sueldos de `salary_entries` confirmados/pagados, si la tabla existe) y resultado neto (resultado operativo − impuestos de `tax_periods` presentados y `other_taxes` pagados, si existen). El saldo de IVA estimado se muestra aparte: es una obligación, no un gasto, y no se resta dos veces. `coherence` comprueba que la suma por proveedor cuadra con el total de compras, que los pagos cuadran con las ventas cobradas (tolerancia 0,02 €) y expone ingresos, gastos y saldo del libro `ledger_entries` del mismo rango junto al último arqueo de caja. `GET /api/reports/daily.csv?...` genera en servidor el mismo desglose (fecha, periodo, cada KPI con su comparativa, proveedores, categorías, pagos y totales del libro) en CSV con BOM para Excel en es-ES; el navegador permite además imprimir/PDF. Con datos vacíos todo se muestra a 0,00 €. Consultan `admin`, `manager` y `cashier`; `waiter` y `kitchen` reciben 403.
### Mesa rectangular: medidas y capacidad (#38)

`shape='rect'` incorpora `width_cm` (80-240 cm), `height_cm` (60-120 cm) y `sides_used` (`long1`, `long2`, `short1`, `short2`). La capacidad recomendada se calcula con 60 cm por comensal en cada lado largo y una plaza por lado corto, limitada a 1-20; se permite sobrescribirla y `GET /api/tables` devuelve `widthCm`, `heightCm`, `sidesUsed`, `seatsRecommended` y `seatsWarning` si la desviación supera dos plazas. La migración convierte las barras existentes en rectangulares de 120 × 60 cm con un lado largo, sin tocar sus comandas.

### Mesa cuadrada: medidas y capacidad (#37)

`dining_tables.width_cm` y `height_cm` se guardan iguales para las mesas cuadradas. El catálogo propone 70→2, 80→4, 90→4, 100→6 y 120→8 plazas; la API exige un lado entero de 50 a 150 cm y una capacidad de 1 a 20, editable. `GET /api/tables` devuelve `widthCm`, `heightCm`, `seatsRecommended` y `seatsWarning` cuando la capacidad se desvía más de dos plazas. La migración asigna 80 cm de lado a las mesas cuadradas existentes; cambiar el lado no afecta a la comanda abierta.

### Mesa redonda: medidas y capacidad (#36)

`dining_tables.diameter_cm` guarda diámetros de 50 a 200 cm en pasos de 0,5 cm. El catálogo de referencia propone 70→3, 90→4, 120→8 y 150→10 comensales, pero la API admite medidas intermedias y una capacidad editable de 1 a 20. `GET /api/tables` devuelve `diameterCm`, `seatsRecommended` y `seatsWarning` (desviación superior a una plaza); la migración asigna 90 cm a las mesas redondas existentes de hasta 4 plazas y 120 cm al resto. Cambiar la medida no toca la comanda abierta; solo se actualizan los campos de la mesa.

## Esquema SQL

Las migraciones ejecutables `database/migrations/001_initial.sql` y `002_inventory_packages_and_vat.sql` crean locales, usuarios y membresías, categorías, carta, ingredientes con formato/precio de compra, recetas y extras compatibles, proveedores, facturas de compra y líneas, menús diarios, pedidos y detalle, pagos, movimientos de stock, cierres de caja, gastos operativos, presupuestos, sesiones, índices y políticas RLS. El runner registra versiones y aplica la segunda migración de forma incremental a instalaciones previas.

## Endpoints

Cookie de sesión requerida en todos salvo el bootstrap y login. Roles: `admin` y `manager` para catálogo/inventario; `waiter` para comandas; `cashier` para cobro y caja. `admin` puede operar todas las áreas.

| Verbo | Endpoint | Función / acceso |
|---|---|---|
| POST | `/api/setup` | Bootstrap único del primer local y administrador; retirar o deshabilitar al desplegar |
| POST | `/api/auth/login` | Identificación por slug, email y contraseña |
| GET | `/api/auth/me` | Perfil de la sesión actual |
| POST | `/api/auth/logout` | Destruir sesión |
| GET | `/api/menu` | Carta activa |
| POST / PATCH | `/api/products`, `/api/products/:id` | Crear, actualizar o desactivar producto |
| POST | `/api/categories` | Crear categoría |
| POST / GET | `/api/daily-menus`, `/api/daily-menus?date=YYYY-MM-DD` | Crear/consultar menú fechado |
| POST | `/api/recipes/:productId` | Reemplazar receta y definir extras permitidos mediante `allowedIngredientIds` |
| GET / POST | `/api/tables` | Mapa de mesas con el estado de su comanda activa / crear mesa (admin, manager) |
| PATCH / DELETE | `/api/tables/:id` | Renombrar, mover en el plano o retirar una mesa (solo sin comanda abierta) |
| GET | `/api/tables` | Incluye `diameterCm`, `seatsRecommended` y `seatsWarning` de mesas redondas |
| GET | `/api/tables` | Incluye también `widthCm` y `heightCm` de mesas cuadradas |
| GET | `/api/tables` | Incluye `sidesUsed` y la capacidad calculada por lados de mesas rectangulares |
| GET | `/api/categories` | Categorías de la carta |
| GET | `/api/products/admin` | Carta completa para gestión, incluidos productos retirados |
| DELETE | `/api/products/:id` | Quitar producto de la carta (se desactiva para conservar el histórico) |
| POST | `/api/orders` | Abrir pedido; con `tableId` lo vincula a la mesa y reutiliza su comanda activa si existe |
| POST | `/api/orders/:id/lines` | Añadir línea de venta |
| GET | `/api/products/:id/modifiers` | Consultar ingredientes de receta y opciones disponibles para personalizar |
| POST | `/api/orders/:id/send` | Enviar comanda a preparación |
| POST | `/api/orders/:id/payments` | Cobro con `method` `card` (datáfono TPV, referencia opcional) o `cash` (con `cashTendered` calcula el cambio). Admite pagos parciales; al completar, cierra, descuenta stock y libera la mesa |
| POST | `/api/orders/:id/close` | Confirmar cierre si el importe está pagado |
| GET / POST | `/api/inventory/ingredients` | Listar/crear ingredientes, formato de paquete, precio neto e IVA habitual |
| PATCH | `/api/inventory/ingredients/:id` | Editar formato, contenido por paquete, precio y stock mínimo |
| POST | `/api/inventory/adjustments` | Ajuste manual con movimiento de auditoría |
| GET | `/api/inventory/replenishment` | Ingredientes por debajo del mínimo |
| GET | `/api/inventory/shopping-list` | Lista sugerida en paquetes, con coste neto y bruto estimado |
| POST | `/api/inventory/shopping-list/generate` | Crear o recalcular el borrador automático según stock mínimo |
| GET | `/api/inventory/shopping-list/current` | Consultar el borrador pendiente de revisión |
| POST / PATCH / DELETE | `/api/inventory/shopping-list/current/lines` | Añadir, cambiar paquetes o quitar ingredientes de la propuesta |
| POST | `/api/inventory/shopping-list/current/approve` | Marcar la propuesta como revisada por el gerente |
| POST | `/api/purchases` | Crear factura borrador, con líneas por paquetes o cantidades base |
| POST | `/api/purchases/:id/receive` | Recibir compra, sumar stock y registrar movimientos |
| GET / POST | `/api/suppliers` | Listar/crear proveedores |
| POST | `/api/expenses` | Registrar gasto operativo con base e IVA |
| POST | `/api/budgets` | Crear o actualizar presupuesto mensual por categoría |
| GET | `/api/reports/daily?date=YYYY-MM-DD&period=day\|week\|month\|year` o `?from=&to=` | Resumen financiero con comparativa, resultado neto y cuadres |
| GET | `/api/reports/daily.csv?from=&to=` | CSV del mismo resumen para Excel |
| POST | `/api/cash-closures` | Registrar arqueo y diferencia de caja |

## Arranque

En la raíz: `cp .env.example .env`, `docker compose up -d db`, `npm install`, `npm run db:migrate`, `npm run dev`. Después del bootstrap inicial, crear categorías, productos, ingredientes y recetas antes de operar el TPV.
