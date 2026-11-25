import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

const REASONS = ['waste', 'breakage', 'staff_meal', 'invitation', 'count_error', 'expiry', 'other'] as const;
type InvitationBody = { description?: string; amount?: number; reason?: string; occurredAt?: string; orderId?: string; notes?: string };
const round = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown, fallback = 0) => v === undefined || v === null || v === '' ? fallback : Number(v);

@ApiTags('losses')
@Controller()
export class LossesController {
  constructor(private readonly db: DbService) {}

  private session(req: AuthRequest, write = false) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin', 'manager', 'cashier'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    if (write && !['admin', 'manager'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }

  @Get('loss/settings') async settings(@Req() req: AuthRequest) {
    this.session(req);
    return this.db.tenant(req, async c => (await c.query('SELECT threshold_pct "thresholdPct" FROM loss_settings WHERE tenant_id=$1', [req.session!.app!.tenantId])).rows[0] || { thresholdPct: 3 });
  }

  @Post('loss/settings') async saveSettings(@Req() req: AuthRequest, @Body() b: { thresholdPct?: number }) {
    const s = this.session(req, true);
    if (!(num(b.thresholdPct) >= 0)) throw new BadRequestException('Umbral no válido');
    return this.db.tenant(req, async c => (await c.query(`INSERT INTO loss_settings(tenant_id,threshold_pct) VALUES($1,$2)
      ON CONFLICT(tenant_id) DO UPDATE SET threshold_pct=excluded.threshold_pct RETURNING threshold_pct "thresholdPct"`, [s.tenantId, num(b.thresholdPct)])).rows[0]);
  }

  /** Invitaciones: se registran como pérdida, nunca como venta a 0 €. */
  @Post('losses/invitations') async invitation(@Req() req: AuthRequest, @Body() b: InvitationBody) {
    const s = this.session(req, true);
    if (!b?.description?.trim() || !(num(b.amount) > 0)) throw new BadRequestException('Descripción e importe requeridos');
    return this.db.tenant(req, async c => (await c.query(`INSERT INTO loss_entries(tenant_id,description,amount,signed_amount,reason,source_type,source_id,occurred_at,notes,created_by)
      VALUES($1,$2,$3,$3,$4,'invitation',$5,$6,$7,$8) RETURNING id,description,amount,reason,occurred_at "occurredAt"`,
      [s.tenantId, b.description!.trim(), round(num(b.amount)), b.reason || 'invitation', b.orderId || null,
        b.occurredAt || new Date().toISOString().slice(0, 10), b.notes?.trim() || null, s.userId])).rows[0]);
  }

  /** Los descuadres se leen directamente de los cierres: no hay imports manuales ni duplicados. */
  @Post('losses/sync-cash') async syncCash(@Req() req: AuthRequest) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      await c.query("DELETE FROM loss_entries WHERE tenant_id=$1 AND source_type='cash'", [s.tenantId]);
      return { created: 0, automatic: true };
    });
  }

  @Get('reports/losses') async report(@Req() req: AuthRequest, @Query('from') from?: string, @Query('to') to?: string) {
    const s = this.session(req);
    const f = from || `${new Date().getFullYear()}-01-01`, t = to || new Date().toISOString().slice(0, 10);
    if (f > t) throw new BadRequestException('Rango no válido');
    const next = new Date(`${t}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    return this.db.tenant(req, async c => {
      const cashier = s.role === 'cashier';
      const movements = (await c.query(`SELECT sm.id,sm.occurred_at "date",sm.reason,sm.loss_value "amount",sm.quantity_delta "quantity",
          i.name "productName",u.full_name "employeeName",sm.source_type "sourceType",sm.notes
        FROM stock_movements sm LEFT JOIN ingredients i ON i.tenant_id=sm.tenant_id AND i.id=sm.ingredient_id
        LEFT JOIN users u ON u.id=sm.created_by
        WHERE sm.tenant_id=$1 AND sm.quantity_delta<0 AND sm.reason IS NOT NULL
          AND sm.occurred_at >= $2::date AND sm.occurred_at < $3::date
          AND ($4::boolean=false OR sm.created_by=$5)`, [s.tenantId, f, next.toISOString().slice(0, 10), cashier, s.userId])).rows;
      const entries = (await c.query(`SELECT le.id,le.occurred_at "date",le.reason,le.amount,le.signed_amount "signedAmount",
          le.description "productName",u.full_name "employeeName",le.source_type "sourceType",le.notes
        FROM loss_entries le LEFT JOIN users u ON u.id=le.created_by
        WHERE le.tenant_id=$1 AND le.occurred_at >= $2::date AND le.occurred_at < $3::date
          AND le.source_type<>'cash'
          AND ($4::boolean=false OR le.created_by=$5)`, [s.tenantId, f, next.toISOString().slice(0, 10), cashier, s.userId])).rows;
      const closures = (await c.query(`SELECT cc.id,cc.business_date "date",cc.cash_difference "difference",u.full_name "employeeName"
        FROM cash_closures cc LEFT JOIN users u ON u.id=cc.closed_by
        WHERE cc.tenant_id=$1 AND cc.business_date >= $2::date AND cc.business_date < $3::date
          AND abs(cc.cash_difference)>0.001 AND ($4::boolean=false OR cc.closed_by=$5)`,
        [s.tenantId, f, next.toISOString().slice(0, 10), cashier, s.userId])).rows;
      const cashLines = closures.map(r => ({
        id: r.id, date: r.date, reason: 'count_error', amount: round(Math.abs(Number(r.difference))),
        signedAmount: round(Number(r.difference)), productName: `Cierre ${r.date}`, employeeName: r.employeeName,
        sourceType: 'cash', notes: 'Diferencia entre efectivo contado y esperado', origin: 'cash'
      }));
      const lines = [...movements.map(m => ({ ...m, origin: 'stock' })), ...entries.map(e => ({ ...e, origin: 'entry' })), ...cashLines]
        .filter(l => Number(l.amount) > 0);
      const byReason = Object.entries(lines.reduce((acc: Record<string, number>, l) => { acc[l.reason] = (acc[l.reason] || 0) + Number(l.amount); return acc; }, {}))
        .map(([reason, amount]) => ({ reason, amount: round(amount) })).sort((a, b) => b.amount - a.amount);
      const byProduct = Object.entries(lines.reduce((acc: Record<string, number>, l) => { const k = l.productName || 'Sin producto'; acc[k] = (acc[k] || 0) + Number(l.amount); return acc; }, {}))
        .map(([product, amount]) => ({ product, amount: round(amount) })).sort((a, b) => b.amount - a.amount);
      const byEmployee = Object.entries(lines.reduce((acc: Record<string, number>, l) => { const k = l.employeeName || 'Sin usuario'; acc[k] = (acc[k] || 0) + Number(l.amount); return acc; }, {}))
        .map(([employee, amount]) => ({ employee, amount: round(amount) })).sort((a, b) => b.amount - a.amount);
      const sales = (await c.query(`SELECT coalesce(sum(net_total),0) net FROM orders WHERE tenant_id=$1 AND status='paid'
        AND (closed_at AT TIME ZONE (SELECT timezone FROM tenants WHERE id=$1))::date >= $2::date
        AND (closed_at AT TIME ZONE (SELECT timezone FROM tenants WHERE id=$1))::date < $3::date`, [s.tenantId, f, next.toISOString().slice(0, 10)])).rows[0];
      const total = lines.reduce((sum, l) => sum + Number(l.amount), 0);
      const cfg = (await c.query('SELECT threshold_pct "thresholdPct" FROM loss_settings WHERE tenant_id=$1', [s.tenantId])).rows[0] || { thresholdPct: 3 };
      const salesNet = Number(sales.net), pct = salesNet > 0 ? round(total / salesNet * 100) : null;
      return { from: f, to: t, total: round(total), lines: lines.map(l => ({ ...l, amount: round(Number(l.amount)) })),
        byReason, byProduct, byEmployee, salesNet: round(salesNet), percentOfSales: pct,
        thresholdPct: Number(cfg.thresholdPct), alert: pct !== null && pct > Number(cfg.thresholdPct), reasons: REASONS };
    });
  }
}
