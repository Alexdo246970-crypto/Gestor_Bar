import { BadRequestException, Body, Controller, Get, Post, Query, Req, Res, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { DbService, AuthRequest } from './db.service';

type Period = 'day' | 'week' | 'month' | 'year' | 'range';
type Bounds = { period: Period; from: string; to: string; end: string; days: number; date: string };
type Kpis = Record<string, number>;
type Variation = { current: number; previous: number; absolute: number; percent: number | null };

const DAY = 86400000;
const round = (n: number) => Math.round(n * 100) / 100;
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const shift = (value: string, days: number) => {
  const d = new Date(`${value}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
};
const isDate = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const KPI_LABELS: Record<string, string> = {
  salesNet: 'Ventas netas', collected: 'Cobros recibidos', billedGross: 'Ventas con IVA',
  purchases: 'Compras a proveedores', ingredientCost: 'Coste de ingredientes', grossMargin: 'Margen bruto',
  operatingExpenses: 'Gastos operativos', payroll: 'Sueldos y Seguridad Social', taxes: 'Impuestos liquidados',
  operatingResult: 'Resultado operativo', netResult: 'Resultado neto',
  vatOutput: 'IVA repercutido', vatInput: 'IVA soportado deducible', vatBalance: 'IVA estimado a liquidar'
};

@ApiTags('finance')
@Controller()
export class FinanceController {
  constructor(private readonly db: DbService) {}

  private allowed(req: AuthRequest) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin', 'manager', 'cashier'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }

  /** Periodos predefinidos por zona horaria de negocio o rango libre validado. */
  private async bounds(c: any, period: string | undefined, date: string | undefined, from: string | undefined, to: string | undefined): Promise<Bounds> {
    if (from || to) {
      if (!isDate(from) || !isDate(to)) throw new BadRequestException('Indica from y to con formato YYYY-MM-DD');
      if (from > to) throw new BadRequestException('La fecha de inicio debe ser anterior o igual a la final');
      const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
      if (days > 731) throw new BadRequestException('El rango máximo es de 2 años');
      return { period: 'range', from, to, end: shift(to, 1), days, date: from };
    }
    const p = period || 'month';
    if (!['day', 'week', 'month', 'year'].includes(p)) throw new BadRequestException('Periodo no válido');
    const d = date || new Date().toISOString().slice(0, 10);
    if (!isDate(d)) throw new BadRequestException('Fecha no válida');
    const b = (await c.query(`SELECT CASE WHEN $2='day' THEN $3::date ELSE date_trunc(CASE WHEN $2='week' THEN 'week' WHEN $2='month' THEN 'month' ELSE 'year' END,$3::date)::date END start_date,
        CASE WHEN $2='day' THEN $3::date+1 ELSE (date_trunc(CASE WHEN $2='week' THEN 'week' WHEN $2='month' THEN 'month' ELSE 'year' END,$3::date)+CASE WHEN $2='week' THEN interval '1 week' WHEN $2='month' THEN interval '1 month' ELSE interval '1 year' END)::date END end_date`,
      [p, d])).rows[0];
    const start = fmt(b.start_date), end = fmt(b.end_date), finish = shift(end, -1);
    return { period: p as Period, from: start, to: finish, end, days: Math.round((Date.parse(finish) - Date.parse(start)) / DAY) + 1, date: d };
  }

  /** Todas las cifras del rango se calculan en el servidor y sin redondear hasta el total. */
  private async figures(c: any, tenant: string, from: string, to: string, end: string, budgetDate: string) {
    const tz = (await c.query('SELECT timezone FROM tenants WHERE id=$1', [tenant])).rows[0]?.timezone || 'Europe/Madrid';
    const sales = (await c.query(`SELECT coalesce(sum(net_total),0) net,coalesce(sum(vat_total),0) vat,coalesce(sum(gross_total),0) gross,count(*)::int orders
      FROM orders WHERE tenant_id=$1 AND status='paid' AND (closed_at AT TIME ZONE $4)::date >= $2 AND (closed_at AT TIME ZONE $4)::date < $3`, [tenant, from, end, tz])).rows[0];
    const payments = (await c.query(`SELECT method,coalesce(sum(amount),0) amount FROM payments
      WHERE tenant_id=$1 AND (paid_at AT TIME ZONE $4)::date >= $2 AND (paid_at AT TIME ZONE $4)::date < $3
      GROUP BY method ORDER BY method`, [tenant, from, end, tz])).rows;
    const purchases = (await c.query(`SELECT coalesce(sum(net_total),0) net,coalesce(sum(vat_total),0) vat,coalesce(sum(gross_total),0) gross,
        coalesce(sum(vat_total) FILTER(WHERE vat_deductible),0) deductible_vat
      FROM purchases WHERE tenant_id=$1 AND status='received' AND (purchased_at AT TIME ZONE $4)::date >= $2 AND (purchased_at AT TIME ZONE $4)::date < $3`, [tenant, from, end, tz])).rows[0];
    const supplierBreakdown = (await c.query(`SELECT coalesce(s.name,'Sin proveedor') supplier,coalesce(sum(p.net_total),0) net,coalesce(sum(p.vat_total),0) vat,
        coalesce(sum(p.gross_total),0) gross,coalesce(sum(p.vat_total) FILTER(WHERE p.vat_deductible),0) deductible_vat
      FROM purchases p LEFT JOIN suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id
      WHERE p.tenant_id=$1 AND p.status='received' AND (p.purchased_at AT TIME ZONE $4)::date >= $2 AND (p.purchased_at AT TIME ZONE $4)::date < $3
      GROUP BY s.name ORDER BY sum(p.gross_total) DESC`, [tenant, from, end, tz])).rows;
    const expenses = (await c.query(`SELECT coalesce(sum(net_amount),0) net,coalesce(sum(vat_amount),0) vat,coalesce(sum(gross_amount),0) gross,
        coalesce(sum(vat_amount) FILTER(WHERE vat_deductible),0) deductible_vat
      FROM expenses WHERE tenant_id=$1 AND expense_date >= $2 AND expense_date < $3`, [tenant, from, end])).rows[0];
    const food = (await c.query(`SELECT coalesce(sum((-quantity_delta)*unit_cost),0) cost FROM stock_movements
      WHERE tenant_id=$1 AND movement_type='sale' AND (occurred_at AT TIME ZONE $4)::date >= $2 AND (occurred_at AT TIME ZONE $4)::date < $3`, [tenant, from, end, tz])).rows[0];
    const expenseBreakdown = (await c.query(`SELECT category,coalesce(sum(net_amount),0) net,coalesce(sum(vat_amount),0) vat,coalesce(sum(gross_amount),0) gross
      FROM expenses WHERE tenant_id=$1 AND expense_date >= $2 AND expense_date < $3 GROUP BY category ORDER BY category`, [tenant, from, end])).rows;
    const budgetPerformance = (await c.query(`SELECT b.category,b.planned_amount planned,coalesce(sum(e.net_amount),0) actual
      FROM budgets b LEFT JOIN expenses e ON e.tenant_id=b.tenant_id AND e.category=b.category AND e.expense_date >= $2 AND e.expense_date < $3
      WHERE b.tenant_id=$1 AND b.budget_month=date_trunc('month',$4::date)::date
      GROUP BY b.category,b.planned_amount ORDER BY b.category`, [tenant, from, end, budgetDate])).rows;

    let payroll = 0;
    if ((await c.query("SELECT to_regclass('public.salary_entries') exists")).rows[0].exists) {
      payroll = Number((await c.query(`SELECT coalesce(sum(gross + social_security_company),0) cost FROM salary_entries
        WHERE tenant_id=$1 AND status IN ('confirmed','paid') AND month >= $2::date AND month <= $3::date`, [tenant, from, to])).rows[0].cost);
    }
    let taxes = 0;
    if ((await c.query("SELECT to_regclass('public.tax_periods') exists")).rows[0].exists) {
      taxes += Number((await c.query(`SELECT coalesce(sum(result),0) total FROM tax_periods
        WHERE tenant_id=$1 AND status IN ('filed','paid') AND start_date <= $3::date AND end_date >= $2::date`, [tenant, from, to])).rows[0].total);
    }
    if ((await c.query("SELECT to_regclass('public.other_taxes') exists")).rows[0].exists) {
      taxes += Number((await c.query(`SELECT coalesce(sum(amount),0) total FROM other_taxes
        WHERE tenant_id=$1 AND paid AND due_date >= $2::date AND due_date <= $3::date`, [tenant, from, to])).rows[0].total);
    }

    const salesNet = round(Number(sales.net)), ingredientCost = round(Number(food.cost));
    const grossMargin = round(salesNet - ingredientCost);
    const collected = round(payments.reduce((sum: number, p: any) => sum + Number(p.amount), 0));
    const purchasesGross = round(Number(purchases.gross)), billedGross = round(Number(sales.gross));
    const inputVat = round(Number(purchases.deductible_vat) + Number(expenses.deductible_vat));
    const operatingExpenses = round(Number(expenses.net)), payrollCost = round(payroll), taxCost = round(taxes);
    const operatingResult = round(grossMargin - operatingExpenses - payrollCost);
    const netResult = round(operatingResult - taxCost);

    const ledger = (await c.query(`SELECT coalesce(sum(total) FILTER (WHERE entry_type='income'),0) income_total,
        coalesce(sum(total) FILTER (WHERE entry_type='expense'),0) expense_total
      FROM ledger_entries WHERE tenant_id=$1 AND entry_date >= $2::date AND entry_date <= $3::date`, [tenant, from, to])).rows[0];
    const cashClosure = (await c.query(`SELECT business_date "businessDate",expected_cash "expectedCash",counted_cash "countedCash",
        cash_difference "cashDifference" FROM cash_closures WHERE tenant_id=$1 AND business_date >= $2::date AND business_date <= $3::date
      ORDER BY business_date DESC LIMIT 1`, [tenant, from, to])).rows[0] || null;
    const supplierGross = round(supplierBreakdown.reduce((sum: number, s: any) => sum + Number(s.gross), 0));
    const ledgerIncome = round(Number(ledger.income_total)), ledgerExpense = round(Number(ledger.expense_total));
    const supplierDifference = round(supplierGross - purchasesGross), paymentDifference = round(collected - billedGross);

    return {
      sales: { ...sales, net: salesNet, vat: round(Number(sales.vat)), gross: billedGross },
      payments, purchases: { ...purchases, net: round(Number(purchases.net)), vat: round(Number(purchases.vat)), gross: purchasesGross, deductible_vat: round(Number(purchases.deductible_vat)) },
      supplierBreakdown, expenses: { ...expenses, net: operatingExpenses, vat: round(Number(expenses.vat)), gross: round(Number(expenses.gross)), deductible_vat: round(Number(expenses.deductible_vat)) },
      expenseBreakdown, budgetPerformance,
      estimatedIngredientCost: ingredientCost, estimatedGrossMargin: grossMargin,
      estimatedOperatingResult: round(grossMargin - operatingExpenses),
      deductibleInputVat: inputVat, estimatedVatBalance: round(Number(sales.vat) - inputVat),
      payroll: payrollCost, taxes: taxCost, operatingResult, netResult,
      kpis: {
        salesNet, collected, billedGross, purchases: purchasesGross, ingredientCost, grossMargin,
        operatingExpenses, payroll: payrollCost, taxes: taxCost, operatingResult, netResult,
        vatOutput: round(Number(sales.vat)), vatInput: inputVat, vatBalance: round(Number(sales.vat) - inputVat)
      } as Kpis,
      coherence: {
        supplierBreakdown: { expected: purchasesGross, actual: supplierGross, difference: supplierDifference, ok: Math.abs(supplierDifference) <= 0.02 },
        payments: { expected: billedGross, actual: collected, difference: paymentDifference, ok: Math.abs(paymentDifference) <= 0.02 },
        ledger: { incomeTotal: ledgerIncome, expenseTotal: ledgerExpense, balance: round(ledgerIncome - ledgerExpense) },
        cashClosure
      }
    };
  }

  private variation(current: Kpis, previous: Kpis): Record<string, Variation> {
    const result: Record<string, Variation> = {};
    for (const [key, value] of Object.entries(current)) {
      const now = round(value), before = round(previous[key] ?? 0);
      result[key] = { current: now, previous: before, absolute: round(now - before), percent: before !== 0 ? round((now - before) / Math.abs(before) * 100) : null };
    }
    return result;
  }

  /** Resumen con rango libre, comparación de igual duración, resultado neto y cuadres. */
  private async summary(req: AuthRequest, date?: string, period?: string, from?: string, to?: string) {
    const s = this.allowed(req);
    return this.db.tenant(req, async c => {
      const b = await this.bounds(c, period, date, from, to);
      const current = await this.figures(c, s.tenantId, b.from, b.to, b.end, b.date);
      const previousTo = shift(b.from, -1), previousFrom = shift(previousTo, -(b.days - 1));
      const previous = await this.figures(c, s.tenantId, previousFrom, previousTo, b.from, previousTo);
      return {
        date: b.date, period: b.period, startDate: b.from, endDate: b.to,
        comparisonPeriod: { from: previousFrom, to: previousTo },
        ...current,
        comparison: { from: previousFrom, to: previousTo, previous: previous.kpis, kpis: this.variation(current.kpis, previous.kpis) }
      };
    });
  }

  @Get('reports/daily') async daily(@Req() req: AuthRequest, @Query('date') date?: string, @Query('period') period?: string,
                                    @Query('from') from?: string, @Query('to') to?: string) {
    return this.summary(req, date, period, from, to);
  }

  /** CSV con el mismo desglose, generado en servidor y codificado para Excel en es-ES. */
  @Get('reports/daily.csv') async summaryCsv(@Req() req: AuthRequest, @Res() res: Response, @Query('date') date?: string,
                                             @Query('period') period?: string, @Query('from') from?: string, @Query('to') to?: string) {
    const data = await this.summary(req, date, period, from, to);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const meta = `${data.period}:${data.startDate}..${data.endDate}`;
    const rows: string[] = ['fecha,periodo,concepto,detalle,importe,anterior,variacion_euros,variacion_porcentaje'];
    const base = [esc(data.startDate), esc(meta)];
    for (const [key, label] of Object.entries(KPI_LABELS)) {
      const v = data.comparison.kpis[key];
      if (!v) continue;
      rows.push([...base, esc(label), 'KPI', v.current, v.previous, v.absolute, v.percent ?? ''].join(','));
    }
    for (const s of data.supplierBreakdown) rows.push([...base, esc('Coste por proveedor'), esc(s.supplier), s.gross, '', '', ''].join(','));
    for (const e of data.expenseBreakdown) rows.push([...base, esc('Gastos por categoría'), esc(e.category), e.net, '', '', ''].join(','));
    for (const p of data.payments) rows.push([...base, esc('Pago recibido'), esc(p.method), p.amount, '', '', ''].join(','));
    rows.push([...base, esc('Cuadre libros'), esc('ingresos'), data.coherence.ledger.incomeTotal, '', '', ''].join(','));
    rows.push([...base, esc('Cuadre libros'), esc('gastos'), data.coherence.ledger.expenseTotal, '', '', ''].join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="resumen-${data.startDate}-${data.endDate}.csv"`);
    res.send(`\ufeff${rows.join('\r\n')}`);
  }

  @Post('expenses') async addExpense(@Req() req: AuthRequest, @Body() b: { date: string; category: string; description: string; netAmount: number; vatRate: number; vatDeductible?: boolean; paymentMethod?: string }) {
    const s = this.allowed(req);
    if (!b?.date || !b.category || !b.description || !Number.isFinite(b.netAmount) || b.netAmount < 0 || !Number.isFinite(b.vatRate) || b.vatRate < 0) throw new BadRequestException('Datos de gasto inválidos');
    return this.db.tenant(req, async c => {
      const vat = Number((b.netAmount * b.vatRate / 100).toFixed(2)), gross = Number((b.netAmount + vat).toFixed(2));
      return (await c.query('INSERT INTO expenses(tenant_id,expense_date,category,description,net_amount,vat_rate,vat_amount,vat_deductible,gross_amount,payment_method,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,expense_date "date",category,description,net_amount "netAmount",vat_amount "vatAmount",gross_amount "grossAmount"',
        [s.tenantId, b.date, b.category, b.description, b.netAmount, b.vatRate, vat, b.vatDeductible !== false, gross, b.paymentMethod || null, s.userId])).rows[0];
    });
  }

  @Post('budgets') async budget(@Req() req: AuthRequest, @Body() b: { month: string; category: string; plannedAmount: number }) {
    const s = this.allowed(req);
    if (!b?.month || !b.category || !Number.isFinite(b.plannedAmount) || b.plannedAmount < 0) throw new BadRequestException('Presupuesto inválido');
    return this.db.tenant(req, async c => (await c.query(`INSERT INTO budgets(tenant_id,budget_month,category,planned_amount) VALUES($1,date_trunc('month',$2::date)::date,$3,$4) ON CONFLICT(tenant_id,budget_month,category) DO UPDATE SET planned_amount=excluded.planned_amount RETURNING id,budget_month "month",category,planned_amount "plannedAmount"`,
      [s.tenantId, b.month, b.category, b.plannedAmount])).rows[0]);
  }

  @Post('cash-closures') async closeCash(@Req() req: AuthRequest, @Body() b: { businessDate: string; openingCash?: number; countedCash: number; notes?: string }) {
    const s = this.allowed(req);
    if (!b?.businessDate || !Number.isFinite(b.countedCash)) throw new BadRequestException('Fecha y efectivo contado requeridos');
    return this.db.tenant(req, async c => {
      const expected = await c.query(`SELECT coalesce($3::numeric,0)+coalesce(sum(p.amount) FILTER (WHERE p.method='cash'),0) amount FROM payments p
        WHERE p.tenant_id=$1 AND (p.paid_at AT TIME ZONE (SELECT timezone FROM tenants WHERE id=$1))::date=$2`, [s.tenantId, b.businessDate, b.openingCash || 0]);
      const amount = Number(expected.rows[0].amount);
      const r = await c.query(`INSERT INTO cash_closures(tenant_id,business_date,opened_at,closed_at,opening_cash,expected_cash,counted_cash,cash_difference,closed_by,notes)
        VALUES($1,$2,$2::timestamp,now(),$3,$4,$5,$5-$4,$6,$7) RETURNING *`, [s.tenantId, b.businessDate, b.openingCash || 0, amount, b.countedCash, s.userId, b.notes || null]);
      return r.rows[0];
    });
  }
}
