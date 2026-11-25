import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { DbService, AuthRequest } from './db.service';

type EntryBody = { date?: string; type?: 'income' | 'expense'; category?: string; account?: 'cash' | 'bank'; amountNet?: number; vat?: number; notes?: string };

@ApiTags('ledger')
@Controller('ledger')
export class LedgerController {
  constructor(private readonly db: DbService) {}

  private session(req: AuthRequest, write = false) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin', 'owner', 'manager', 'cashier'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    if (write && !['admin', 'manager'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }

  @Get() async list(@Req() req: AuthRequest, @Query('from') from?: string, @Query('to') to?: string,
                    @Query('category') category?: string, @Query('account') account?: string,
                    @Query('page') page = '1', @Query('pageSize') pageSize = '100') {
    const s = this.session(req);
    const p = Math.max(1, Math.floor(Number(page) || 1)), size = Math.min(500, Math.max(1, Math.floor(Number(pageSize) || 100)));
    const args = [s.tenantId, from || null, to || null, category || null, account || null];
    return this.db.tenant(req, async c => {
      const result = await c.query(`SELECT id,entry_date "date",entry_type "type",category,account,
          amount_net "amountNet",vat,total,source_type "sourceType",source_id "sourceId",reference,notes,created_at "createdAt"
        FROM ledger_entries WHERE tenant_id=$1
          AND ($2::date IS NULL OR entry_date >= $2::date) AND ($3::date IS NULL OR entry_date <= $3::date)
          AND ($4::text IS NULL OR category=$4) AND ($5::text IS NULL OR account=$5)
        ORDER BY entry_date DESC,created_at DESC LIMIT $6 OFFSET $7`, [...args, size, (p - 1) * size]);
      const totals = await c.query(`SELECT
          coalesce(sum(amount_net) FILTER (WHERE entry_type='income'),0) "incomeNet",
          coalesce(sum(vat) FILTER (WHERE entry_type='income'),0) "incomeVat",
          coalesce(sum(total) FILTER (WHERE entry_type='income'),0) "incomeTotal",
          coalesce(sum(amount_net) FILTER (WHERE entry_type='expense'),0) "expenseNet",
          coalesce(sum(vat) FILTER (WHERE entry_type='expense'),0) "expenseVat",
          coalesce(sum(total) FILTER (WHERE entry_type='expense'),0) "expenseTotal"
        FROM ledger_entries WHERE tenant_id=$1
          AND ($2::date IS NULL OR entry_date >= $2::date) AND ($3::date IS NULL OR entry_date <= $3::date)
          AND ($4::text IS NULL OR category=$4) AND ($5::text IS NULL OR account=$5)`, args);
      const byCategory = await c.query(`SELECT category,entry_type "type",sum(total) total FROM ledger_entries WHERE tenant_id=$1
          AND ($2::date IS NULL OR entry_date >= $2::date) AND ($3::date IS NULL OR entry_date <= $3::date)
          AND ($4::text IS NULL OR category=$4) AND ($5::text IS NULL OR account=$5)
        GROUP BY category,entry_type ORDER BY total DESC`, args);
      const count = (await c.query(`SELECT count(*)::int "total" FROM ledger_entries WHERE tenant_id=$1
          AND ($2::date IS NULL OR entry_date >= $2::date) AND ($3::date IS NULL OR entry_date <= $3::date)
          AND ($4::text IS NULL OR category=$4) AND ($5::text IS NULL OR account=$5)`, args)).rows[0].total;
      return { lines: result.rows, totals: totals.rows[0], byCategory: byCategory.rows, page: p, pageSize: size, total: count };
    });
  }

  /** CSV del detalle filtrado, con el mismo criterio que la consulta principal. */
  @Get('csv') async csv(@Req() req: AuthRequest, @Res() res: Response, @Query('from') from?: string, @Query('to') to?: string,
                        @Query('category') category?: string, @Query('account') account?: string) {
    this.session(req);
    const rows = await this.db.tenant(req, async c => (await c.query(`SELECT entry_date "date",entry_type "type",category,account,
        amount_net "amountNet",vat,total,source_type "sourceType",reference,notes
      FROM ledger_entries WHERE tenant_id=$1
        AND ($2::date IS NULL OR entry_date >= $2::date) AND ($3::date IS NULL OR entry_date <= $3::date)
        AND ($4::text IS NULL OR category=$4) AND ($5::text IS NULL OR account=$5)
      ORDER BY entry_date DESC,created_at DESC`,
      [req.session!.app!.tenantId, from || null, to || null, category || null, account || null])).rows);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['fecha;tipo;categoria;cuenta;base;iva;total;origen;referencia;notas',
      ...rows.map((r: any) => [r.date, r.type, r.category, r.account, r.amountNet, r.vat, r.total, r.sourceType || 'manual', r.reference, r.notes].map(esc).join(';'))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cuentas-${from || 'inicio'}-${to || 'hoy'}.csv"`);
    res.send(`\ufeff${csv}`);
  }

  /** Catálogo compartido por cuentas, gastos y presupuestos: valores por defecto + los ya usados. */
  @Get('categories') async categories(@Req() req: AuthRequest) {
    this.session(req);
    return this.db.tenant(req, async c => {
      const defaults = ['ventas', 'compras', 'personal', 'impuestos', 'suministros', 'alquiler', 'otros'];
      const used = (await c.query(`SELECT DISTINCT category FROM (
          SELECT category FROM ledger_entries WHERE tenant_id=$1
          UNION SELECT category FROM expenses WHERE tenant_id=$1
          UNION SELECT category FROM budgets WHERE tenant_id=$1
        ) c ORDER BY category`, [req.session!.app!.tenantId])).rows.map((r: any) => r.category as string);
      return [...new Set([...defaults, ...used])];
    });
  }

  @Post() async create(@Req() req: AuthRequest, @Body() b: EntryBody) {
    const s = this.session(req, true);
    if (!['income', 'expense'].includes(b?.type!)) throw new BadRequestException('Tipo no válido');
    if (!b.category?.trim()) throw new BadRequestException('La categoría es obligatoria');
    if (!b.notes?.trim()) throw new BadRequestException('La justificación es obligatoria');
    const net = Number(b.amountNet), vat = Number(b.vat ?? 0);
    if (!Number.isFinite(net) || net <= 0 || !Number.isFinite(vat) || vat < 0) throw new BadRequestException('Importe no válido');
    const account = b.account ?? 'cash';
    if (!['cash', 'bank'].includes(account)) throw new BadRequestException('Cuenta no válida');
    const date = b.date ? new Date(b.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    if (Number.isNaN(Date.parse(date))) throw new BadRequestException('Fecha no válida');
    if (Number.isNaN(Date.parse(b.date || ''))) throw new BadRequestException('La fecha es obligatoria');
    return this.db.tenant(req, async c => {
      const r = await c.query(`INSERT INTO ledger_entries
        (tenant_id,entry_date,entry_type,category,account,amount_net,vat,total,source_type,reference,notes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'manual',null,$9,$10)
        RETURNING id,entry_date "date",entry_type "type",category,account,amount_net "amountNet",vat,total,notes`,
        [s.tenantId, date, b.type, b.category!.trim(), account, net, vat, Math.round((net + vat) * 100) / 100, b.notes?.trim() || null, s.userId]);
      return r.rows[0];
    });
  }
}
