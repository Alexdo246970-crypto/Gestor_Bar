import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { DbService, AuthRequest } from './db.service';

const round = (n: number) => Math.round(n * 100) / 100;
const day = (d: Date) => d.toISOString().slice(0, 10);
const shift = (value: string, days: number) => {
  const d = new Date(`${value}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return day(d);
};
const shiftYear = (value: string) => {
  const d = new Date(`${value}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() - 1); return day(d);
};
const monthKey = (value: unknown) => {
  const m = String(value || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new BadRequestException('Mes no válido (AAAA-MM)');
  return m;
};
const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;

type AmortizationBody = { name?: string; monthlyAmount?: number; startMonth?: string; endMonth?: string };

type Figures = {
  salesNet: number; salesGross: number; orders: number; cogs: number; grossMargin: number;
  personal: number; otherExpenses: number; ebitda: number; amortization: number;
  beforeTax: number; taxes: number; net: number; ledger: any[]; expenseBreakdown: any[];
};

@ApiTags('reports')
@Controller('reports')
export class IncomeController {
  constructor(private readonly db: DbService) {}

  private session(req: AuthRequest) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin', 'manager'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }

  private range(from?: string, to?: string) {
    const f = from || new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString().slice(0, 10);
    const t = to || new Date().toISOString().slice(0, 10);
    if (Number.isNaN(Date.parse(f)) || Number.isNaN(Date.parse(t))) throw new BadRequestException('Fechas no válidas');
    if (f > t) throw new BadRequestException('La fecha de inicio debe ser anterior o igual a la final');
    if ((Date.parse(t) - Date.parse(f)) / 86400000 > 731) throw new BadRequestException('El rango máximo es de 2 años');
    return { from: f, to: t, next: shift(t, 1) };
  }

  private async figures(c: any, tenant: string, from: string, to: string, next: string): Promise<Figures> {
    const tz = (await c.query('SELECT timezone FROM tenants WHERE id=$1', [tenant])).rows[0]?.timezone || 'Europe/Madrid';
    const sales = (await c.query(`SELECT coalesce(sum(net_total),0) net,coalesce(sum(gross_total),0) gross,count(*)::int orders
      FROM orders WHERE tenant_id=$1 AND status='paid' AND (closed_at AT TIME ZONE $5)::date >= $2::date AND (closed_at AT TIME ZONE $5)::date < $3::date`, [tenant, from, next, to, tz])).rows[0];
    const cogsRow = (await c.query(`SELECT coalesce(sum((-quantity_delta)*unit_cost),0) cost FROM stock_movements
      WHERE tenant_id=$1 AND movement_type='sale' AND (occurred_at AT TIME ZONE $4)::date >= $2::date AND (occurred_at AT TIME ZONE $4)::date < $3::date`, [tenant, from, next, tz])).rows[0];
    const expenses = (await c.query(`SELECT coalesce(sum(net_amount),0) net FROM expenses WHERE tenant_id=$1 AND expense_date >= $2::date AND expense_date < $3::date`, [tenant, from, next])).rows[0];
    const breakdown = (await c.query(`SELECT category,sum(net_amount) net FROM expenses WHERE tenant_id=$1 AND expense_date >= $2::date AND expense_date < $3::date GROUP BY category ORDER BY category`, [tenant, from, next])).rows;

    let personal = 0;
    if ((await c.query("SELECT to_regclass('public.salary_entries') exists")).rows[0].exists) {
      personal = Number((await c.query(`SELECT coalesce(sum(gross + social_security_company),0) cost FROM salary_entries
        WHERE tenant_id=$1 AND status IN ('confirmed','paid') AND month >= date_trunc('month',$2::date)::date AND month < $3::date`, [tenant, from, next])).rows[0].cost);
    }
    let taxes = 0;
    if ((await c.query("SELECT to_regclass('public.tax_periods') exists")).rows[0].exists) {
      taxes += Number((await c.query(`SELECT coalesce(sum(result),0) total FROM tax_periods WHERE tenant_id=$1 AND status IN ('filed','paid')
        AND start_date < $3::date AND end_date >= $2::date`, [tenant, from, next])).rows[0].total);
    }
    if ((await c.query("SELECT to_regclass('public.other_taxes') exists")).rows[0].exists) {
      taxes += Number((await c.query(`SELECT coalesce(sum(amount),0) total FROM other_taxes WHERE tenant_id=$1 AND paid
        AND (due_date IS NULL OR (due_date >= $2::date AND due_date < $3::date))`, [tenant, from, next])).rows[0].total);
    }
    // La amortización es mensual: se cuenta una vez por mes activo dentro del rango.
    const amortRows = (await c.query(`SELECT monthly_amount "monthlyAmount",start_month "startMonth",end_month "endMonth"
      FROM amortizations WHERE tenant_id=$1 AND active AND start_month <= $3::date
        AND (end_month IS NULL OR end_month >= $2::date)`, [tenant, from, next])).rows;
    const firstMonth = from.slice(0, 7), lastMonth = to.slice(0, 7);
    const amortization = amortRows.reduce((sum: number, a: any) => {
      const start = String(a.startMonth).slice(0, 7);
      const end = a.endMonth ? String(a.endMonth).slice(0, 7) : lastMonth;
      const months = Math.max(0, Math.min(monthIndex(end), monthIndex(lastMonth)) - Math.max(monthIndex(start), monthIndex(firstMonth)) + 1);
      return sum + Number(a.monthlyAmount) * months;
    }, 0);

    const salesNet = round(Number(sales.net)), cogs = round(Number(cogsRow.cost));
    const grossMargin = round(salesNet - cogs), personalCost = round(personal);
    const otherExpenses = round(Number(expenses.net));
    const ebitda = round(grossMargin - personalCost - otherExpenses);
    const beforeTax = round(ebitda - amortization);
    return {
      salesNet, salesGross: round(Number(sales.gross)), orders: sales.orders, cogs, grossMargin,
      personal: personalCost, otherExpenses, ebitda, amortization: round(amortization), beforeTax,
      taxes: round(taxes), net: round(beforeTax - taxes),
      ledger: (await c.query(`SELECT entry_date "date",entry_type "type",category,source_type "sourceType",amount_net "amountNet",vat,total,reference,notes
        FROM ledger_entries WHERE tenant_id=$1 AND entry_date >= $2::date AND entry_date < $3::date ORDER BY entry_date DESC LIMIT 500`, [tenant, from, next])).rows,
      expenseBreakdown: breakdown
    };
  }

  private lines(f: Figures) {
    const pct = (value: number) => f.salesNet > 0 ? round(value / f.salesNet * 100) : null;
    return [
      { key: 'sales', label: 'Ingresos por ventas', amount: f.salesNet, formula: 'Pedidos pagados (neto)', sources: ['order'], weight: null },
      { key: 'cogs', label: 'Coste de mercancía', amount: -f.cogs, formula: 'Consumo real por receta (stock_movements sale × coste)', sources: ['sale'], weight: pct(f.cogs) },
      { key: 'gross', label: 'Margen bruto', amount: f.grossMargin, formula: 'Ventas netas − coste de mercancía', sources: ['order', 'sale'], weight: pct(f.grossMargin), highlight: true },
      { key: 'personal', label: 'Personal', amount: -f.personal, formula: 'Nóminas confirmadas (bruto + SS empresa)', sources: ['salary', 'salary_ss'], weight: pct(f.personal) },
      { key: 'expenses', label: 'Suministros y otros gastos', amount: -f.otherExpenses, formula: 'Gastos operativos del periodo', sources: ['expense', 'manual', 'purchase'], weight: pct(f.otherExpenses) },
      { key: 'ebitda', label: 'EBITDA', amount: f.ebitda, formula: 'Margen bruto − personal − otros gastos', sources: [], weight: pct(f.ebitda), highlight: true },
      { key: 'amortization', label: 'Amortización', amount: -f.amortization, formula: 'Amortizaciones manuales activas', sources: ['amortization'], weight: pct(f.amortization) },
      { key: 'beforeTax', label: 'Resultado antes de impuestos', amount: f.beforeTax, formula: 'EBITDA − amortización', sources: [], weight: pct(f.beforeTax) },
      { key: 'taxes', label: 'Impuestos', amount: -f.taxes, formula: 'IVA liquidado + otros impuestos pagados', sources: ['tax_period', 'other_tax'], weight: pct(f.taxes) },
      { key: 'net', label: 'Resultado neto', amount: f.net, formula: 'Resultado antes de impuestos − impuestos', sources: [], weight: pct(f.net), highlight: true }
    ];
  }

  private async statement(req: AuthRequest, from?: string, to?: string) {
    const s = this.session(req);
    const { from: f, to: t, next } = this.range(from, to);
    return this.db.tenant(req, async c => {
      const current = await this.figures(c, s.tenantId, f, t, next);
      const days = Math.round((Date.parse(t) - Date.parse(f)) / 86400000) + 1;
      const previousFrom = shift(f, -days), previousTo = shift(f, -1);
      const yearFrom = shiftYear(f), yearTo = shiftYear(t);
      const previous = await this.figures(c, s.tenantId, previousFrom, previousTo, shift(previousTo, 1));
      const previousYear = await this.figures(c, s.tenantId, yearFrom, yearTo, shift(yearTo, 1));
      const ytd = await this.figures(c, s.tenantId, `${t.slice(0, 4)}-01-01`, t, next);
      const indicator = (value: number, base: number) => base !== 0 ? round(value / base * 100) : null;
      return {
        from: f, to: t, lines: this.lines(current),
        comparison: { previous: { from: previousFrom, to: previousTo, net: previous.net, grossMargin: previous.grossMargin }, previousYear: { from: yearFrom, to: yearTo, net: previousYear.net, grossMargin: previousYear.grossMargin } },
        ytd: { net: ytd.net, grossMargin: ytd.grossMargin },
        indicators: {
          grossMarginPct: indicator(current.grossMargin, current.salesNet),
          personalPct: indicator(current.personal, current.salesNet),
          avgTicket: current.orders ? round(current.salesGross / current.orders) : 0,
          breakEvenSales: indicator(current.grossMargin, current.salesNet) ? round((current.personal + current.otherExpenses + current.amortization) / (current.grossMargin / current.salesNet)) : null
        },
        ledger: current.ledger, expenseBreakdown: current.expenseBreakdown
      };
    });
  }

  @Get('amortizations') async amortizations(@Req() req: AuthRequest) {
    const s = this.session(req);
    return this.db.tenant(req, async c => (await c.query(`SELECT id,name,monthly_amount "monthlyAmount",start_month "startMonth",end_month "endMonth",active
      FROM amortizations WHERE tenant_id=$1 ORDER BY start_month DESC,name`, [s.tenantId])).rows);
  }

  @Post('amortizations') async addAmortization(@Req() req: AuthRequest, @Body() b: AmortizationBody) {
    const s = this.session(req);
    if (s.role !== 'admin') throw new ForbiddenException('Solo el administrador puede registrar amortizaciones');
    const start = monthKey(b.startMonth), end = b.endMonth ? monthKey(b.endMonth) : null;
    if (!b?.name?.trim()) throw new BadRequestException('El concepto es obligatorio');
    if (!(Number(b.monthlyAmount) > 0) || !Number.isFinite(Number(b.monthlyAmount))) throw new BadRequestException('El importe mensual debe ser positivo');
    if (end && end < start) throw new BadRequestException('El mes final no puede ser anterior al inicial');
    return this.db.tenant(req, async c => (await c.query(`INSERT INTO amortizations
      (tenant_id,name,monthly_amount,start_month,end_month,created_by) VALUES($1,$2,$3,$4::date,$5::date,$6)
      RETURNING id,name,monthly_amount "monthlyAmount",start_month "startMonth",end_month "endMonth",active`,
      [s.tenantId, b.name!.trim(), round(Number(b.monthlyAmount)), `${start}-01`, end ? `${end}-01` : null, s.userId])).rows[0]);
  }

  @Delete('amortizations/:id') async deactivateAmortization(@Req() req: AuthRequest, @Param('id') id: string) {
    const s = this.session(req);
    if (s.role !== 'admin') throw new ForbiddenException('Solo el administrador puede dar de baja amortizaciones');
    return this.db.tenant(req, async c => {
      const r = await c.query('UPDATE amortizations SET active=false WHERE tenant_id=$1 AND id=$2 AND active RETURNING id', [s.tenantId, id]);
      if (!r.rowCount) throw new BadRequestException('Amortización no encontrada o ya inactiva');
      return { ok: true };
    });
  }

  @Get('income-statement') async statementJson(@Req() req: AuthRequest, @Query('from') from?: string, @Query('to') to?: string) {
    return this.statement(req, from, to);
  }

  @Get('income-statement.csv') async statementCsv(@Req() req: AuthRequest, @Res() res: Response, @Query('from') from?: string, @Query('to') to?: string) {
    const data = await this.statement(req, from, to);
    const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows: string[] = ['periodo,descripcion,importe,formula,porcentaje_sobre_ventas'];
    rows.push(`${escape(`${data.from}..${data.to}`)},,,,,`);
    for (const l of data.lines) rows.push([escape(data.from), escape(l.label), l.amount, escape(l.formula), l.weight ?? ''].join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="resultados-${data.from}-${data.to}.csv"`);
    res.send(`\ufeff${rows.join('\r\n')}`);
  }
}
