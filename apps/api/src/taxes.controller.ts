import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

type SettingsBody = { frequency?: 'monthly' | 'quarterly'; vatRegime?: string; dueDay?: number; thresholdPct?: number };
type OtherTaxBody = { name?: string; amount?: number; period?: string; dueDate?: string; reference?: string; notes?: string };

const round = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown, fallback = 0) => v === undefined || v === null || v === '' ? fallback : Number(v);

@ApiTags('taxes')
@Controller('tax')
export class TaxesController {
  constructor(private readonly db: DbService) {}

  private session(req: AuthRequest, write = false) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin', 'manager'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    if (write && s.role !== 'admin') throw new ForbiddenException('Solo el administrador puede gestionar impuestos');
    return s;
  }

  @Get('settings') async settings(@Req() req: AuthRequest) {
    this.session(req);
    return this.db.tenant(req, async c => {
      const row = (await c.query(`SELECT frequency,vat_regime "vatRegime",due_day "dueDay",threshold_pct "thresholdPct"
        FROM tax_settings WHERE tenant_id=$1`, [req.session!.app!.tenantId])).rows[0];
      return row || { frequency: 'quarterly', vatRegime: 'general', dueDay: 20, thresholdPct: 3 };
    });
  }

  @Post('settings') async saveSettings(@Req() req: AuthRequest, @Body() b: SettingsBody) {
    const s = this.session(req, true);
    if (b.frequency && !['monthly', 'quarterly'].includes(b.frequency)) throw new BadRequestException('Frecuencia no válida');
    if (b.dueDay !== undefined && (!Number.isInteger(b.dueDay) || b.dueDay < 1 || b.dueDay > 28)) throw new BadRequestException('Día de vencimiento no válido (1-28)');
    return this.db.tenant(req, async c => (await c.query(`INSERT INTO tax_settings(tenant_id,frequency,vat_regime,due_day,threshold_pct)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id) DO UPDATE SET frequency=excluded.frequency,vat_regime=excluded.vat_regime,
      due_day=excluded.due_day,threshold_pct=excluded.threshold_pct
      RETURNING frequency,vat_regime "vatRegime",due_day "dueDay",threshold_pct "thresholdPct"`,
      [s.tenantId, b.frequency || 'quarterly', b.vatRegime || 'general', b.dueDay ?? 20, b.thresholdPct ?? 3])).rows[0]);
  }

  private async calculation(c: any, tenant: string, start: string, end: string) {
    const tz = (await c.query('SELECT timezone FROM tenants WHERE id=$1', [tenant])).rows[0]?.timezone || 'Europe/Madrid';
    const output = (await c.query(`SELECT coalesce(sum(vat_total),0) vat FROM orders WHERE tenant_id=$1 AND status='paid'
      AND (closed_at AT TIME ZONE $4)::date >= $2::date AND (closed_at AT TIME ZONE $4)::date < $3::date`, [tenant, start, end, tz])).rows[0];
    const purchases = (await c.query(`SELECT coalesce(sum(vat_total),0) vat FROM purchases WHERE tenant_id=$1 AND status='received' AND vat_deductible
      AND (purchased_at AT TIME ZONE $4)::date >= $2::date AND (purchased_at AT TIME ZONE $4)::date < $3::date`, [tenant, start, end, tz])).rows[0];
    const expenses = (await c.query(`SELECT coalesce(sum(vat_amount),0) vat FROM expenses WHERE tenant_id=$1 AND vat_deductible
      AND expense_date >= $2::date AND expense_date < $3::date`, [tenant, start, end])).rows[0];
    const outputVat = round(Number(output.vat)), inputVat = round(Number(purchases.vat) + Number(expenses.vat));
    return { outputVat, inputVat, rawResult: Number(output.vat) - Number(purchases.vat) - Number(expenses.vat), result: round(Number(output.vat) - Number(purchases.vat) - Number(expenses.vat)) };
  }

  @Get('periods') async periods(@Req() req: AuthRequest, @Query('year') year?: string) {
    this.session(req);
    return this.db.tenant(req, async c => {
      const rows = (await c.query(`SELECT id,period_key "periodKey",start_date "startDate",end_date "endDate",due_date "dueDate",
        output_vat "outputVat",input_vat "inputVat",rounding_adjustment "roundingAdjustment",result,status,filed_at "filedAt",paid_at "paidAt",notes
        FROM tax_periods WHERE tenant_id=$1 AND ($2::int IS NULL OR extract(year from start_date)=$2::int)
        ORDER BY start_date DESC`, [req.session!.app!.tenantId, year ? Number(year) : null])).rows;
      return rows;
    });
  }

  /** Genera los periodos del año y guarda el cálculo con las facturas incluidas. */
  @Post('periods/generate') async generate(@Req() req: AuthRequest, @Body() b: { year?: number }) {
    const s = this.session(req, true);
    const year = Number(b.year || new Date().getFullYear());
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new BadRequestException('Año no válido');
    return this.db.tenant(req, async c => {
      const cfg = (await c.query('SELECT frequency,due_day "dueDay" FROM tax_settings WHERE tenant_id=$1', [s.tenantId])).rows[0] || { frequency: 'quarterly', dueDay: 20 };
      const step = cfg.frequency === 'monthly' ? 1 : 3;
      const created: string[] = [];
      for (let month = 1; month <= 12; month += step) {
        const start = new Date(Date.UTC(year, month - 1, 1));
        const end = new Date(Date.UTC(year, month - 1 + step, 1));
        const dueMonth = month - 1 + step;
        const due = new Date(Date.UTC(year + Math.floor(dueMonth / 12), dueMonth % 12, Math.min(Number(cfg.dueDay), 28)));
        const key = step === 1 ? `${year}-${String(month).padStart(2, '0')}` : `${year}-Q${month / step + 1}`;
        const calc = await this.calculation(c, s.tenantId, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
        const r = (await c.query(`INSERT INTO tax_periods(tenant_id,period_key,start_date,end_date,due_date,output_vat,input_vat,rounding_adjustment,result,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (tenant_id,period_key) DO UPDATE SET output_vat=excluded.output_vat,input_vat=excluded.input_vat,
            rounding_adjustment=excluded.rounding_adjustment,result=excluded.result,due_date=excluded.due_date
          WHERE tax_periods.status='open' RETURNING id`,
          [s.tenantId, key, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), due.toISOString().slice(0, 10),
            calc.outputVat, calc.inputVat, round(calc.result - calc.rawResult), calc.result, s.userId])).rows[0];
        if (!r) continue;
        created.push(r.id);
        await c.query('DELETE FROM tax_period_entries WHERE tenant_id=$1 AND period_id=$2', [s.tenantId, r.id]);
        const sources: [string, string, unknown][] = [
          ['order', `SELECT id,closed_at at,net_total,vat_total FROM orders WHERE tenant_id=$2 AND status='paid' AND closed_at >= $3 AND closed_at < $4`, null],
          ['purchase', `SELECT id,purchased_at at,net_total,vat_total FROM purchases WHERE tenant_id=$2 AND status='received' AND vat_deductible AND purchased_at >= $3 AND purchased_at < $4`, null],
          ['expense', `SELECT id,expense_date at,net_amount net_total,vat_amount vat_total FROM expenses WHERE tenant_id=$2 AND vat_deductible AND expense_date >= $3::date AND expense_date < $4::date`, null]
        ];
        for (const [sourceType, sql] of sources) {
          const rows = (await c.query(sql, [s.tenantId, s.tenantId, start.toISOString(), end.toISOString()])).rows;
          for (const row of rows) {
            await c.query(`INSERT INTO tax_period_entries(tenant_id,period_id,source_type,source_id,operation_date,amount_net,vat,description)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,period_id,source_type,source_id) DO NOTHING`,
              [s.tenantId, r.id, sourceType, row.id, String(row.at).slice(0, 10), row.net_total, row.vat_total, sourceType]);
          }
        }
      }
      return { generated: created.length, year, frequency: cfg.frequency };
    });
  }

  @Get('periods/:id') async period(@Req() req: AuthRequest, @Param('id') id: string) {
    this.session(req);
    return this.db.tenant(req, async c => {
      const row = (await c.query('SELECT * FROM tax_periods WHERE tenant_id=$1 AND id=$2', [req.session!.app!.tenantId, id])).rows[0];
      if (!row) throw new BadRequestException('Periodo no encontrado');
      const entries = (await c.query(`SELECT source_type "sourceType",source_id "sourceId",operation_date "operationDate",amount_net "amountNet",vat,description
        FROM tax_period_entries WHERE tenant_id=$1 AND period_id=$2 ORDER BY operation_date`, [req.session!.app!.tenantId, id])).rows;
      return { ...row, entries };
    });
  }

  @Post('periods/:id/close') async close(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: { notes?: string }) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const p = (await c.query("SELECT * FROM tax_periods WHERE tenant_id=$1 AND id=$2 AND status='open' FOR UPDATE", [s.tenantId, id])).rows[0];
      if (!p) throw new BadRequestException('Periodo no encontrado o ya cerrado');
      const frozen = (await c.query('SELECT count(*)::int count FROM tax_period_entries WHERE tenant_id=$1 AND period_id=$2', [s.tenantId, id])).rows[0].count;
      if (!frozen) throw new BadRequestException('Genera el periodo antes de cerrarlo');
      const result = Number(p.result);
      if (result > 0) {
        await c.query(`INSERT INTO ledger_entries(tenant_id,entry_date,entry_type,category,account,amount_net,vat,total,source_type,source_id,reference,notes,created_by)
          VALUES($1,$2,'expense','Impuestos','bank',$3,0,$3,'tax_period',$4,$5,$6,$7)
          ON CONFLICT (tenant_id,source_type,source_id) DO NOTHING`,
          [s.tenantId, p.due_date, result, id, p.period_key, `Liquidación ${p.period_key}${b.notes ? ` · ${b.notes}` : ''}`, s.userId]);
      }
      await c.query("UPDATE tax_periods SET status='filed',filed_at=now(),notes=coalesce($3,notes) WHERE tenant_id=$1 AND id=$2", [s.tenantId, id, b.notes?.trim() || null]);
      return { ok: true, status: 'filed', ledgerEntry: result > 0 };
    });
  }

  @Post('periods/:id/pay') async pay(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: { paidAt?: string }) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const r = await c.query("UPDATE tax_periods SET status='paid',paid_at=coalesce($3::date,paid_at) WHERE tenant_id=$1 AND id=$2 AND status='filed' RETURNING id,status", [s.tenantId, id, b.paidAt || null]);
      if (!r.rowCount) throw new BadRequestException('El periodo debe estar presentado antes de pagarlo');
      return r.rows[0];
    });
  }

  @Get('other') async other(@Req() req: AuthRequest) {
    this.session(req);
    return this.db.tenant(req, async c => (await c.query(`SELECT id,name,amount,period,due_date "dueDate",reference,notes,paid,paid_at "paidAt"
      FROM other_taxes WHERE tenant_id=$1 ORDER BY due_date NULLS LAST,name`, [req.session!.app!.tenantId])).rows);
  }

  @Post('other') async addOther(@Req() req: AuthRequest, @Body() b: OtherTaxBody) {
    const s = this.session(req, true);
    if (!b?.name?.trim()) throw new BadRequestException('Nombre del impuesto requerido');
    if (!(num(b.amount) > 0)) throw new BadRequestException('Importe no válido');
    return this.db.tenant(req, async c => (await c.query(`INSERT INTO other_taxes(tenant_id,name,amount,period,due_date,reference,notes,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,amount,period,due_date "dueDate",reference,notes,paid`,
      [s.tenantId, b.name!.trim(), round(num(b.amount)), b.period?.trim() || null, b.dueDate || null, b.reference?.trim() || null, b.notes?.trim() || null, s.userId])).rows[0]);
  }

  @Post('other/:id/pay') async payOther(@Req() req: AuthRequest, @Param('id') id: string) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const t = (await c.query("SELECT * FROM other_taxes WHERE tenant_id=$1 AND id=$2 AND NOT paid FOR UPDATE", [s.tenantId, id])).rows[0];
      if (!t) throw new BadRequestException('Impuesto no encontrado o ya pagado');
      await c.query(`INSERT INTO ledger_entries(tenant_id,entry_date,entry_type,category,account,amount_net,vat,total,source_type,source_id,reference,notes,created_by)
        VALUES($1,$2,'expense','Impuestos','bank',$3,0,$3,'other_tax',$4,$5,$6,$7)
        ON CONFLICT (tenant_id,source_type,source_id) DO NOTHING`,
        [s.tenantId, t.due_date || new Date().toISOString().slice(0, 10), t.amount, id, t.reference, t.name, s.userId]);
      await c.query('UPDATE other_taxes SET paid=true,paid_at=now() WHERE tenant_id=$1 AND id=$2', [s.tenantId, id]);
      return { ok: true };
    });
  }

  @Get('alerts') async alerts(@Req() req: AuthRequest) {
    this.session(req);
    return this.db.tenant(req, async c => {
      const periods = (await c.query(`SELECT period_key "periodKey",due_date "dueDate",result,status FROM tax_periods
        WHERE tenant_id=$1 AND status='open' AND due_date <= current_date + interval '15 days' ORDER BY due_date LIMIT 10`, [req.session!.app!.tenantId])).rows;
      const taxes = (await c.query(`SELECT name,due_date "dueDate",amount FROM other_taxes
        WHERE tenant_id=$1 AND NOT paid AND due_date <= current_date + interval '15 days' ORDER BY due_date LIMIT 10`, [req.session!.app!.tenantId])).rows;
      return { periods, otherTaxes: taxes };
    });
  }
}
