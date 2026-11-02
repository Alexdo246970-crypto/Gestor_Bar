import { Injectable, Inject } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { Request } from 'express';

export interface AppSession { userId: string; tenantId: string; role: string; tenantName?: string }
export type AuthRequest = Request & { session: Request['session'] & { app?: AppSession } };

@Injectable()
export class DbService {
  constructor(@Inject('PG_POOL') private readonly pool: Pool) {}
  async tenant<T>(req: AuthRequest, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!req.session?.app?.tenantId) throw new Error('AUTH_REQUIRED');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [req.session.app.tenantId]);
      const result = await fn(client);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async query<T extends QueryResultRow>(sql: string, values: unknown[] = []) { return this.pool.query<T>(sql, values); }
  async bootstrap<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
