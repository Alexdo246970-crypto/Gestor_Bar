# barraOS · Gestión para bares y restaurantes

Aplicación web para gestionar el servicio de un bar o restaurante: mapa de mesas, TPV y comandas, cocina, carta, inventario, compras y herramientas financieras. Incluye una API REST con NestJS, una interfaz React y PostgreSQL con separación de datos por local.

## Guía de arranque

Hay dos formas de abrir el proyecto: el modo demo permite explorar la interfaz sin configurar servicios; el modo completo ejecuta la API y PostgreSQL y conserva los datos en la base de datos.

### Opción rápida: modo demo

Requiere Node.js 20 o posterior y npm. Desde la carpeta raíz del proyecto:

```bash
npm install
VITE_DEMO_MODE=true npm run dev --workspace @bar/web
```

Abre la dirección local que muestra Vite, normalmente <http://localhost:5173>, y pulsa **Modo administrador** → **Entrar como administrador (demo)**. La demo incluye datos de ejemplo y guarda cambios en el almacenamiento local del navegador. No necesita PostgreSQL ni inicia la API; algunas acciones son simuladas.

Para detener el servidor, vuelve a la terminal y pulsa `Ctrl+C`.

### Arranque completo: API, web y PostgreSQL

Requiere Node.js 20 o posterior, npm y Docker Compose. Desde la carpeta raíz:

1. Instala las dependencias y crea tu configuración local:

   ```bash
   npm install
   cp .env.example .env
   ```

2. Inicia PostgreSQL:

   ```bash
   docker compose up -d db
   ```

3. Carga las variables de `.env` en la terminal y ejecuta las migraciones:

   ```bash
   set -a
   source .env
   set +a
   npm run db:migrate
   ```

4. En esa misma terminal, inicia la API y la web:

   ```bash
   npm run dev
   ```

   Abre <http://localhost:5173>. La API está en <http://localhost:3000/api> y su documentación OpenAPI en <http://localhost:3000/docs>.

5. Crea el primer local y la cuenta administradora. Con la API en marcha, ejecuta en otra terminal:

   ```bash
   curl -X POST http://localhost:3000/api/setup \
     -H 'Content-Type: application/json' \
     -d '{"tenantName":"Mi bar","slug":"mi-bar","fullName":"Nombre Administrador","email":"admin@ejemplo.com","password":"CambiaEstaClave123!"}'
   ```

   La contraseña debe tener al menos 12 caracteres. El bootstrap solo funciona mientras no haya usuarios en la base de datos. Después, entra en **Entrar en un local** con el identificador (`mi-bar`), el correo y la contraseña. La cuenta creada también tiene acceso al **Modo administrador** global.

Para apagar PostgreSQL: `docker compose down`. Los datos se conservan en el volumen `postgres_data`; para borrarlos junto con el contenedor usa `docker compose down -v`.

### Configuración

`.env.example` contiene las variables de referencia:

| Variable | Uso |
|---|---|
| `DATABASE_URL` | Conexión de la API a PostgreSQL. |
| `PORT` | Puerto de la API (por defecto `3000`). |
| `SESSION_SECRET` | Secreto de las sesiones; usa uno aleatorio y de al menos 32 caracteres en producción. |
| `WEB_ORIGIN` | Origen permitido para la web (por defecto `http://localhost:5173`). |
| `VITE_API_URL` | URL de la API consumida por la web. |
| `RESEND_API_KEY`, `EMAIL_FROM`, `PUBLIC_APP_URL` | Envío de enlaces de acceso por correo a cuentas de cliente. Opcionales. |

La API y Vite leen las variables del entorno del proceso. Por eso, en el arranque completo se cargan explícitamente con `source .env`; no subas el archivo `.env` al repositorio.

## Funcionalidades

- TPV, pedidos, personalización de platos, pagos parciales y mapa de mesas con salas, uniones y pedidos QR.
- Gestión de equipo y perfiles de cocina, con permisos por rol.
- Carta, recetas, inventario, auditoría de movimientos, lista de compra y facturas de proveedores.
- Libro de cuentas, cierres de caja, finanzas, estado de resultados, nóminas, impuestos, tesorería y pérdidas.
- Administración de varios locales desde una cuenta de plataforma.
- Cuentas opcionales de cliente con enlaces de acceso, preferencias alimentarias y herramientas de privacidad.

## Estructura del repositorio

```text
apps/api/                 API NestJS y migrador de base de datos
apps/web/                 Aplicación React y modo demo
packages/contracts/       Tipos compartidos
database/migrations/      Migraciones SQL de PostgreSQL
docs/architecture.md      Arquitectura, modelo de datos y referencia de API
```

## Comandos útiles

```bash
npm run dev       # API y web en modo desarrollo
npm run build     # Compila contratos, API y web
npm run db:migrate # Aplica las migraciones pendientes
```

## Seguridad y alcance

La sesión identifica el local y el rol del usuario; la API aplica controles de acceso y PostgreSQL añade aislamiento por local mediante RLS y claves foráneas compuestas. Las sesiones usan cookies `HttpOnly`. El endpoint `/api/setup` es exclusivamente para el primer arranque y deja de aceptar solicitudes tras crear el primer usuario.

El informe fiscal es orientativo y debe revisarse con asesoría contable. Antes de exponer el servicio en producción, configura TLS, secretos adecuados, copias de seguridad, límites de solicitudes, monitorización y una política de retención de datos.

Para más detalle técnico y endpoints, consulta [docs/architecture.md](docs/architecture.md).
