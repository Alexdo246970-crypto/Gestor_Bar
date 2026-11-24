import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

type AccountBody = { kind?: 'cash' | 'bank'; name?: string; initialBalance?: number; iban?: string; active?: boolean; reason?: string };
type TransferBody = { fromId?: string; toId?: string; amount?: number; date?: string; notes?: string; allowNegative?: boolean; reason?: string };
type CommitmentBody = { description?: string; amount?: number; dueDate?: string; sourceType?: string; sourceId?: string; account?: 'cash' | 'bank' };

const round = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown, fallback = 0) => v === undefined || v === null || v === '' ? fallback : Number(v);

@ApiTags('treasury')
@Controller('treasury')
export class TreasuryController {
  constructor(private readonly db: DbService) {}

  private session(req: AuthRequest, write = false) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin', 'manager', 'cashier'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    if (write && !['admin', 'manager'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }

  private async accounts(c: any, tenant: string, cashierOnly = false) {
    const rows = (await c.query(`SELECT id,kind,name,initial_balance "initialBalance",iban,active
      FROM treasury_accounts WHERE tenant_id=$1 AND active ${cashierOnly ? "AND kind='cash'" : ''} ORDER BY kind,name`, [tenant])).rows;
    for (const a of rows) {
      const ledger = (await c.query(`SELECT coalesce(sum(total) FILTER (WHERE entry_type='income'),0)-coalesce(sum(total) FILTER (WHERE entry_type='expense'),0) total
        FROM ledger_entries WHERE tenant_id=$1 AND account=$2`, [tenant, a.kind])).rows[0];
      const out = (await c.query('SELECT coalesce(sum(amount),0) total FROM treasury_transfers WHERE tenant_id=$1 AND from_account_id=$2', [tenant, a.id])).rows[0];
      const incoming = (await c.query('SELECT coalesce(sum(amount),0) total FROM treasury_transfers WHERE tenant_id=$1 AND to_account_id=$2', [tenant, a.id])).rows[0];
      a.balance = round(Number(a.initialBalance) + Number(ledger.total) - Number(out.total) + Number(incoming.total));
    }
    return rows;
  }

  @Get('accounts') async listAccounts(@Req() req: AuthRequest) {
    const s = this.session(req);
    return this.db.tenant(req, async c => this.accounts(c, s.tenantId, s.role === 'cashier'));
  }

  @Post('accounts') async addAccount(@Req() req: AuthRequest, @Body() b: AccountBody) {
    const s = this.session(req, true);
    if (!['cash', 'bank'].includes(b.kind || '')) throw new BadRequestException('Tipo de cuenta no válido');
    const initial = num(b.initialBalance);
    if (!Number.isFinite(initial)) throw new BadRequestException('Saldo inicial no válido');
    if (initial < 0 && !b.reason?.trim()) throw new BadRequestException('Un saldo inicial negativo requiere motivo');
    return this.db.tenant(req, async c => {
      const dup = (await c.query('SELECT id FROM treasury_accounts WHERE tenant_id=$1 AND kind=$2 AND active', [s.tenantId, b.kind])).rows[0];
      if (dup) throw new BadRequestException('Ya existe una cuenta activa de ese tipo; edítala o desactívala');
      return (await c.query(`INSERT INTO treasury_accounts(tenant_id,kind,name,initial_balance,iban,active,opening_reason,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,kind,name,initial_balance "initialBalance",iban,active`,
        [s.tenantId, b.kind, b.name?.trim() || (b.kind === 'cash' ? 'Caja' : 'Banco'), initial, b.iban?.trim() || null, b.active !== false, b.reason?.trim() || null, s.userId])).rows[0];
    });
  }

  @Patch('accounts/:id') async updateAccount(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: AccountBody) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const r = await c.query(`UPDATE treasury_accounts SET name=coalesce($3,name),iban=coalesce($4,iban),active=coalesce($5,active)
        WHERE tenant_id=$1 AND id=$2 RETURNING id,kind,name,initial_balance "initialBalance",iban,active`,
        [s.tenantId, id, b.name?.trim() || null, b.iban?.trim() || null, b.active ?? null]);
      if (!r.rowCount) throw new BadRequestException('Cuenta no encontrada');
      return r.rows[0];
    });
  }

  @Post('transfers') async transfer(@Req() req: AuthRequest, @Body() b: TransferBody) {
    const s = this.session(req, true);
    const amount = num(b.amount);
    if (!(amount > 0)) throw new BadRequestException('Importe de traspaso no válido');
    if (b.fromId === b.toId) throw new BadRequestException('Las cuentas deben ser distintas');
    return this.db.tenant(req, async c => {
      const rows = (await c.query('SELECT id,kind FROM treasury_accounts WHERE tenant_id=$1 AND active AND id = ANY($2::uuid[])', [s.tenantId, [b.fromId, b.toId]])).rows;
      const from = rows.find(r => r.id === b.fromId), to = rows.find(r => r.id === b.toId);
      if (!from || !to) throw new BadRequestException('Cuentas no encontradas');
      const accounts = await this.accounts(c, s.tenantId);
      const balance = accounts.find((a: any) => a.id === from.id)?.balance ?? 0;
      if (balance - amount < 0 && !b.allowNegative) throw new BadRequestException('El traspaso dejaría la cuenta en negativo; confirma y dale un motivo');
      if (balance - amount < 0 && !b.reason?.trim()) throw new BadRequestException('Indica el motivo del saldo negativo');
      return (await c.query(`INSERT INTO treasury_transfers(tenant_id,from_account_id,to_account_id,amount,transfer_date,notes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,amount,transfer_date "date",notes`,
        [s.tenantId, b.fromId, b.toId, amount, b.date || new Date().toISOString().slice(0, 10), b.notes?.trim() || null, s.userId])).rows[0];
    });
  }

  /** Sincroniza compromisos desde facturas recibidas y nóminas confirmadas si esas tablas existen. */
  @Post('commitments/sync') async sync(@Req() req: AuthRequest) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      let created = 0;
      const purchases = (await c.query("SELECT to_regclass('public.purchases') exists")).rows[0].exists;
      if (purchases) {
        const rows = (await c.query(`SELECT id,invoice_number,invoice_date,due_date,gross_total,paid_amount,payment_method
          FROM purchases WHERE tenant_id=$1 AND status='received' AND gross_total > paid_amount`, [s.tenantId])).rows;
        for (const p of rows) {
          const r = await c.query(`INSERT INTO treasury_commitments(tenant_id,description,amount,due_date,source_type,source_id,account)
            VALUES($1,$2,$3,$4,'purchase',$5,$6) ON CONFLICT (tenant_id,source_type,source_id) DO UPDATE
            SET amount=excluded.amount,due_date=excluded.due_date WHERE treasury_commitments.paid=false RETURNING id`,
            [s.tenantId, p.invoice_number || 'Factura sin número', round(Number(p.gross_total) - Number(p.paid_amount)), p.due_date, p.id, p.payment_method === 'card' ? 'bank' : 'cash']);
          created += r.rowCount ?? 0;
        }
      }
      const salaries = (await c.query("SELECT to_regclass('public.salary_entries') exists")).rows[0].exists;
      if (salaries) {
        const rows = (await c.query(`SELECT s.id,e.name,s.gross,s.social_security_company,s.payment_date,s.month
          FROM salary_entries s JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id
          WHERE s.tenant_id=$1 AND s.status IN ('confirmed','paid') AND s.paid_at IS NULL`, [s.tenantId])).rows;
        for (const p of rows) {
          const r = await c.query(`INSERT INTO treasury_commitments(tenant_id,description,amount,due_date,source_type,source_id,account)
            VALUES($1,$2,$3,$4,'salary',$5,'bank') ON CONFLICT (tenant_id,source_type,source_id) DO UPDATE
            SET amount=excluded.amount,due_date=excluded.due_date WHERE treasury_commitments.paid=false RETURNING id`,
            [s.tenantId, `Nómina ${String(p.month).slice(0, 7)} · ${p.name}`, round(Number(p.gross) + Number(p.social_security_company)), p.payment_date, p.id]);
          created += r.rowCount ?? 0;
        }
      }
      return { created };
    });
  }

  @Get('commitments') async commitments(@Req() req: AuthRequest) {
    const s = this.session(req);
    return this.db.tenant(req, async c => (await c.query(`SELECT id,description,amount,due_date "dueDate",source_type "sourceType",account,paid
      FROM treasury_commitments WHERE tenant_id=$1 AND paid=false ${s.role === 'cashier' ? "AND account='cash'" : ''}
      ORDER BY due_date NULLS LAST,description`, [s.tenantId])).rows);
  }

  @Post('commitments') async addCommitment(@Req() req: AuthRequest, @Body() b: CommitmentBody) {
    const s = this.session(req, true);
    if (!b?.description?.trim() || !(num(b.amount) > 0)) throw new BadRequestException('Descripción e importe requeridos');
    return this.db.tenant(req, async c => (await c.query(`INSERT INTO treasury_commitments(tenant_id,description,amount,due_date,source_type,source_id,account,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,description,amount,due_date "dueDate",account,paid`,
      [s.tenantId, b.description!.trim(), round(num(b.amount)), b.dueDate || null, b.sourceType || 'manual', b.sourceId || null, b.account || 'bank', s.userId])).rows[0]);
  }

  @Post('commitments/:id/pay') async payCommitment(@Req() req: AuthRequest, @Param('id') id: string) {
    this.session(req, true);
    return this.db.tenant(req, async c => {
      const r = await c.query('UPDATE treasury_commitments SET paid=true,paid_at=now() WHERE tenant_id=$1 AND id=$2 AND NOT paid RETURNING id', [req.session!.app!.tenantId, id]);
      if (!r.rowCount) throw new BadRequestException('Compromiso no encontrado o ya pagado');
      return { ok: true };
    });
  }

  @Get('cash-closures') async cashClosures(@Req() req: AuthRequest) {
    const s = this.session(req);
    return this.db.tenant(req, async c => (await c.query(`SELECT business_date "businessDate",opening_cash "openingCash",expected_cash "expectedCash",
      counted_cash "countedCash",cash_difference "cashDifference",notes FROM cash_closures WHERE tenant_id=$1 ORDER BY business_date DESC LIMIT 30`, [s.tenantId])).rows);
  }

  @Get('summary') async summary(@Req() req: AuthRequest, @Query('days') days = '30') {
    const s = this.session(req);
    const limit = Math.min(365, Math.max(1, Number(days) || 30));
    return this.db.tenant(req, async c => {
      const accounts = await this.accounts(c, s.tenantId, s.role === 'cashier');
      const commitments = (await c.query(`SELECT id,description,amount,due_date "dueDate",account FROM treasury_commitments
        WHERE tenant_id=$1 AND NOT paid ${s.role === 'cashier' ? "AND account='cash'" : ''} ORDER BY due_date NULLS LAST`, [s.tenantId])).rows;
      const committed = commitments.reduce((sum, r) => sum + Number(r.amount), 0);
      const evolution = (await c.query(`SELECT entry_date "date",account,
          sum(total) FILTER (WHERE entry_type='income') income,
          sum(total) FILTER (WHERE entry_type='expense') expense
        FROM ledger_entries WHERE tenant_id=$1 AND entry_date >= current_date - $2::int
        GROUP BY entry_date,account ORDER BY entry_date DESC`, [s.tenantId, limit])).rows;
      const cashClosure = (await c.query('SELECT expected_cash "expectedCash",counted_cash "countedCash",cash_difference "cashDifference" FROM cash_closures WHERE tenant_id=$1 ORDER BY business_date DESC LIMIT 1', [s.tenantId])).rows[0] || null;
      const total = accounts.reduce((sum: number, a: any) => sum + Number(a.balance), 0);
      return { accounts, total: round(total), commitments, committed: round(committed), availableReal: round(total - committed), evolution, cashClosure };
    });
  }
}
