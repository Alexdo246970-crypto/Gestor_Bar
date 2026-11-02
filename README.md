# Bar Manager SaaS

Base multi-tenant para gestión de bares y restaurantes. Incluye API REST NestJS, SPA React y PostgreSQL. El modelo usa claves foráneas compuestas por `tenant_id` y Row-Level Security (RLS) como defensa adicional.

## Requisitos y arranque

- Node.js 20+
- Docker Compose (o PostgreSQL 16 local)

```bash
cp .env.example .env
docker compose up -d db
npm install
npm run db:migrate
npm run dev
```

API: `http://localhost:3000/api`; documentación OpenAPI: `http://localhost:3000/api/docs`; web: `http://localhost:5173`.

Crear el primer local y administrador mediante `POST /api/setup` (solo disponible mientras no exista ningún usuario; deshabilitar/eliminar este endpoint antes de exponer el servicio públicamente). El endpoint devuelve las credenciales iniciales una sola vez y exige una contraseña fuerte.

## Estructura

```text
apps/api/src/       API NestJS por módulos
apps/web/src/       SPA React con TPV y administración inicial
packages/contracts/ Tipos compartidos
database/           Migración PostgreSQL, RLS e índices
```

## Seguridad y límites del MVP

- El login identifica el local por `slug`, email y contraseña. Las sesiones se guardan en PostgreSQL y se transportan en cookie `HttpOnly`, `Secure` en producción y `SameSite=Lax`.
- El tenant se resuelve desde la sesión, nunca desde el cuerpo de una petición. La API establece `app.tenant_id` localmente en la transacción; las tablas tenant-scoped aplican RLS y FKs compuestas.
- Roles: `admin`, `manager`, `waiter`, `cashier`. Los permisos se aplican con guards de NestJS.
- El pedido descuenta stock una única vez al cerrarse/pagarse; la transacción registra movimientos de inventario. Una anulación crea reversos, no borra movimientos.
- La contabilidad es un informe operativo, no un sistema de presentación fiscal. Confirmar tipos, fechas y tratamiento del IVA con asesoría contable.
- Para producción: TLS, secretos administrados, rate limiting, copias de seguridad, auditoría, política de retención, monitoreo y revisión de seguridad. Desactivar `/setup` una vez creado el primer administrador.

Consulta `docs/architecture.md` para relaciones, flujos y endpoints.
