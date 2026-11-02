const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS app_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const existing = await client.query("SELECT to_regclass('public.tenants') AS tenants");
    const tracked = await client.query('SELECT version FROM app_migrations');
    if (existing.rows[0].tenants && !tracked.rows.some(row => row.version === '001_initial.sql')) {
      // Databases created by the original one-shot migration already have 001.
      await client.query("INSERT INTO app_migrations(version) VALUES('001_initial.sql') ON CONFLICT DO NOTHING");
    }
    const directory = path.resolve(__dirname, '../../../database/migrations');
    const migrations = fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
    for (const migration of migrations) {
      const applied = await client.query('SELECT 1 FROM app_migrations WHERE version=$1', [migration]);
      if (applied.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(directory, migration), 'utf8'));
        await client.query('INSERT INTO app_migrations(version) VALUES($1)', [migration]);
        await client.query('COMMIT');
        console.log(`Applied ${migration}`);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally { await client.end(); }
})().catch(error => { console.error(error); process.exit(1); });
