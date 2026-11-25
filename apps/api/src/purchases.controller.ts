import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

type PurchaseLineBody = { ingredientId?: string; description?: string; quantity?: number; packages?: number; unitPriceNet?: number; vatRate?: number };
type PurchaseBody = {
  supplierId?: string; invoiceNumber?: string; purchasedAt?: string; invoiceDate?: string; dueDate?: string;
  paymentMethod?: string; vatDeductible?: boolean; notes?: string; lines?: PurchaseLineBody[];
};
type PaymentBody = { amount: number; method?: string; account?: 'cash' | 'bank'; reference?: string };

const round = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown, fallback = 0) => v === undefined || v === null || v === '' ? fallback : Number(v);

@ApiTags('purchases')
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly db: DbService) {}

  private session(req: AuthRequest, write = false) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin', 'manager', 'cashier'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    if (write && !['admin', 'manager'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }

  private async lines(c: any, tenant: string, purchaseId: string, lines: PurchaseLineBody[]) {
    if (!Array.isArray(lines) || !lines.length) throw new BadRequestException('Añade al menos una línea de compra');
    await c.query('DELETE FROM purchase_lines WHERE tenant_id=$1 AND purchase_id=$2', [tenant, purchaseId]);
    let net = 0, vat = 0;
    for (const l of lines) {
      const description = l.description?.trim() || null;
      const ingredientId = l.ingredientId?.trim() || null;
      if (!!ingredientId === !!description) throw new BadRequestException('Cada línea debe indicar un ingrediente o una descripción libre');
      let quantity = num(l.quantity, 1), unitPriceNet = num(l.unitPriceNet), vatRate = num(l.vatRate, 21), packageCount: number | null = null;
      if (ingredientId) {
        const cfg = (await c.query('SELECT package_size,package_price_net,default_vat_rate FROM ingredients WHERE tenant_id=$1 AND id=$2 AND active', [tenant, ingredientId])).rows[0];
        if (!cfg) throw new BadRequestException('Ingrediente no disponible');
        packageCount = l.packages === undefined ? null : num(l.packages);
        quantity = packageCount !== null ? packageCount * Number(cfg.package_size) : num(l.quantity);
        unitPriceNet = packageCount !== null ? Number(cfg.package_price_net) / Number(cfg.package_size) : num(l.unitPriceNet);
        vatRate = l.vatRate === undefined ? Number(cfg.default_vat_rate) : num(l.vatRate);
      }
      if (!Number.isFinite(quantity) || quantity <= 0) throw new BadRequestException('Cantidad de línea no válida');
      if (!Number.isFinite(unitPriceNet) || unitPriceNet < 0) throw new BadRequestException('Precio de línea no válido');
      if (!Number.isFinite(vatRate) || vatRate < 0) throw new BadRequestException('IVA de línea no válido');
      const lineNet = round(quantity * unitPriceNet), lineVat = round(lineNet * vatRate / 100);
      net += lineNet; vat += lineVat;
      await c.query(`INSERT INTO purchase_lines(tenant_id,purchase_id,ingredient_id,description,quantity,package_count,unit_price_net,vat_rate,line_net,line_vat,line_gross)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [tenant, purchaseId, ingredientId, description, quantity, packageCount, unitPriceNet, vatRate, lineNet, lineVat, round(lineNet + lineVat)]);
    }
    await c.query('UPDATE purchases SET net_total=$3,vat_total=$4,gross_total=$3+$4 WHERE tenant_id=$1 AND id=$2', [tenant, purchaseId, round(net), round(vat)]);
  }

  @Post() async create(@Req() req: AuthRequest, @Body() b: PurchaseBody) {
    const s = this.session(req, true);
    const purchasedAt = b.purchasedAt || new Date().toISOString();
    const invoiceDate = b.invoiceDate || purchasedAt.slice(0, 10);
    if (Number.isNaN(Date.parse(invoiceDate))) throw new BadRequestException('Fecha de factura no válida');
    return this.db.tenant(req, async c => {
      const p = (await c.query(`INSERT INTO purchases
        (tenant_id,supplier_id,invoice_number,purchased_at,invoice_date,due_date,status,payment_method,vat_deductible,notes)
        VALUES($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9) RETURNING id`,
        [s.tenantId, b.supplierId || null, b.invoiceNumber?.trim() || null, purchasedAt, invoiceDate, b.dueDate || null,
          b.paymentMethod || null, b.vatDeductible !== false, b.notes?.trim() || null])).rows[0];
      await this.lines(c, s.tenantId, p.id, b.lines || []);
      return this.detail(c, s.tenantId, p.id);
    });
  }

  private async detail(c: any, tenant: string, id: string) {
    const header = (await c.query(`SELECT p.id,p.invoice_number "invoiceNumber",p.purchased_at "purchasedAt",p.invoice_date "invoiceDate",
        p.due_date "dueDate",p.status,p.payment_status "paymentStatus",p.paid_amount "paidAmount",p.payment_method "paymentMethod",
        p.vat_deductible "vatDeductible",p.net_total "netTotal",p.vat_total "vatTotal",p.gross_total "grossTotal",p.notes,
        p.supplier_id "supplierId",s.name "supplierName",p.gross_total-p.paid_amount "pendingAmount"
      FROM purchases p LEFT JOIN suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id
      WHERE p.tenant_id=$1 AND p.id=$2`, [tenant, id])).rows[0];
    if (!header) throw new BadRequestException('Factura no encontrada');
    const lines = (await c.query(`SELECT l.id,l.description,l.quantity,l.package_count "packageCount",l.unit_price_net "unitPriceNet",
        l.vat_rate "vatRate",l.line_net "lineNet",l.line_vat "lineVat",l.line_gross "lineGross",l.ingredient_id "ingredientId",i.name "ingredientName"
      FROM purchase_lines l LEFT JOIN ingredients i ON i.tenant_id=l.tenant_id AND i.id=l.ingredient_id
      WHERE l.tenant_id=$1 AND l.purchase_id=$2 ORDER BY l.description NULLS LAST,i.name NULLS LAST`, [tenant, id])).rows;
    const payments = (await c.query(`SELECT id,amount,method,account,reference,paid_at "paidAt" FROM purchase_payments
      WHERE tenant_id=$1 AND purchase_id=$2 ORDER BY paid_at`, [tenant, id])).rows;
    return { ...header, lines, payments };
  }

  /** Listado con filtros por fecha de factura, proveedor, estado de recepción o estado de pago. */
  @Get() async list(@Req() req: AuthRequest, @Query('from') from?: string, @Query('to') to?: string,
                    @Query('supplierId') supplierId?: string, @Query('status') status?: string) {
    this.session(req);
    return this.db.tenant(req, async c => {
      const filter = status && ['pending', 'partial', 'paid'].includes(status) ? 'p.payment_status' : 'p.status';
      const rows = (await c.query(`SELECT p.id,p.invoice_number "invoiceNumber",p.invoice_date "invoiceDate",p.due_date "dueDate",
          p.status,p.payment_status "paymentStatus",p.paid_amount "paidAmount",p.gross_total "grossTotal",
          p.gross_total-p.paid_amount "pendingAmount",p.vat_deductible "vatDeductible",s.name "supplierName",
          (SELECT count(*)::int FROM purchase_lines l WHERE l.tenant_id=p.tenant_id AND l.purchase_id=p.id) "lineCount"
        FROM purchases p LEFT JOIN suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id
        WHERE p.tenant_id=$1 AND ($2::date IS NULL OR p.invoice_date >= $2::date)
          AND ($3::date IS NULL OR p.invoice_date <= $3::date)
          AND ($4::uuid IS NULL OR p.supplier_id=$4::uuid)
          AND ($5::text IS NULL OR ${filter}=$5)
        ORDER BY p.invoice_date DESC,p.id DESC LIMIT 500`,
        [from || null, to || null, supplierId || null, status || null])).rows;
      const totals = rows.reduce((acc: any, r: any) => {
        acc.gross += Number(r.grossTotal); acc.paid += Number(r.paidAmount); acc.pending += Number(r.pendingAmount);
        return acc;
      }, { gross: 0, paid: 0, pending: 0 });
      return { lines: rows, totals: { gross: round(totals.gross), paid: round(totals.paid), pending: round(totals.pending) } };
    });
  }

  @Get(':id') async get(@Req() req: AuthRequest, @Param('id') id: string) {
    this.session(req);
    return this.db.tenant(req, async c => this.detail(c, req.session!.app!.tenantId, id));
  }

  @Patch(':id') async update(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: PurchaseBody) {
    const s = this.session(req, true);
    if (b.invoiceDate && Number.isNaN(Date.parse(b.invoiceDate))) throw new BadRequestException('Fecha de factura no válida');
    return this.db.tenant(req, async c => {
      const p = (await c.query("SELECT status FROM purchases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [s.tenantId, id])).rows[0];
      if (!p) throw new BadRequestException('Factura no encontrada');
      if (p.status !== 'draft') throw new BadRequestException('Solo se pueden editar facturas en borrador');
      await c.query(`UPDATE purchases SET supplier_id=coalesce($3,supplier_id),invoice_number=coalesce($4,invoice_number),
          invoice_date=coalesce($5,invoice_date),due_date=coalesce($6,due_date),payment_method=coalesce($7,payment_method),
          vat_deductible=coalesce($8,vat_deductible),notes=coalesce($9,notes)
        WHERE tenant_id=$1 AND id=$2`,
        [s.tenantId, id, b.supplierId ?? null, b.invoiceNumber?.trim() || null, b.invoiceDate || null, b.dueDate || null,
          b.paymentMethod || null, b.vatDeductible ?? null, b.notes?.trim() || null]);
      if (b.lines) await this.lines(c, s.tenantId, id, b.lines);
      return this.detail(c, s.tenantId, id);
    });
  }

  /** Recibe la mercancía: actualiza stock y coste medio y genera un único gasto en el libro. */
  @Post(':id/receive') async receive(@Req() req: AuthRequest, @Param('id') id: string) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const p = (await c.query('SELECT * FROM purchases WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [s.tenantId, id])).rows[0];
      if (!p || p.status !== 'draft') throw new BadRequestException('Factura inexistente o ya recibida');
      const lines = (await c.query(`SELECT ingredient_id,sum(quantity) quantity,sum(quantity*unit_price_net)/nullif(sum(quantity),0) unit_cost
        FROM purchase_lines WHERE tenant_id=$1 AND purchase_id=$2 AND ingredient_id IS NOT NULL GROUP BY ingredient_id`, [s.tenantId, id])).rows;
      for (const l of lines) {
        await c.query(`UPDATE ingredients SET current_unit_cost=CASE WHEN current_stock+$3>0
            THEN (current_stock*current_unit_cost+$3*$4)/(current_stock+$3) ELSE $4 END,
            current_stock=current_stock+$3 WHERE tenant_id=$1 AND id=$2`, [s.tenantId, l.ingredient_id, l.quantity, l.unit_cost]);
        await c.query(`INSERT INTO stock_movements(tenant_id,ingredient_id,movement_type,quantity_delta,unit_cost,source_type,source_id,created_by)
          VALUES($1,$2,'purchase',$3,$4,'purchase',$5,$6)`, [s.tenantId, l.ingredient_id, l.quantity, l.unit_cost, id, s.userId]);
      }
      const deductible = p.vat_deductible !== false;
      const vat = deductible ? Number(p.vat_total) : 0;
      await c.query(`INSERT INTO ledger_entries(tenant_id,entry_date,entry_type,category,account,amount_net,vat,total,source_type,source_id,reference,notes,created_by)
        VALUES($1,$2,'expense','compras',$3,$4,$5,$6,'purchase',$7,$8,$9,$10)
        ON CONFLICT (tenant_id,source_type,source_id) DO NOTHING`,
        [s.tenantId, p.invoice_date, p.payment_method === 'card' ? 'bank' : 'cash', p.net_total, vat, round(Number(p.net_total) + vat),
          id, p.invoice_number, deductible ? null : 'IVA no deducible', s.userId]);
      await c.query("UPDATE purchases SET status='received' WHERE tenant_id=$1 AND id=$2", [s.tenantId, id]);
      return { ok: true, receivedLines: lines.length, ledgerEntry: true };
    });
  }

  /** Pagos totales o parciales; el gasto contable ya se registró al recibir. */
  @Post(':id/payments') async pay(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: PaymentBody) {
    const s = this.session(req, true);
    const amount = num(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Importe de pago no válido');
    return this.db.tenant(req, async c => {
      const p = (await c.query('SELECT status,paid_amount,gross_total FROM purchases WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [s.tenantId, id])).rows[0];
      if (!p || p.status !== 'received') throw new BadRequestException('Solo se pueden pagar facturas recibidas');
      if (Number(p.paid_amount) + amount > Number(p.gross_total) + 0.01) throw new BadRequestException('El pago supera el total de la factura');
      const account = b.account || (b.method === 'card' || p.payment_method === 'card' ? 'bank' : 'cash');
      if (!['cash', 'bank'].includes(account)) throw new BadRequestException('Cuenta no válida');
      await c.query(`INSERT INTO purchase_payments(tenant_id,purchase_id,amount,method,account,reference,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [s.tenantId, id, amount, b.method || p.payment_method || 'cash', account, b.reference?.trim() || null, s.userId]);
      const paid = round(Number(p.paid_amount) + amount);
      const paymentStatus = paid + 0.001 >= Number(p.gross_total) ? 'paid' : 'partial';
      await c.query('UPDATE purchases SET paid_amount=$3,payment_status=$4 WHERE tenant_id=$1 AND id=$2', [s.tenantId, id, paid, paymentStatus]);
      return { paidAmount: paid, paymentStatus, pendingAmount: round(Number(p.gross_total) - paid) };
    });
  }

  @Post(':id/void') async void(@Req() req: AuthRequest, @Param('id') id: string) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const p = (await c.query('SELECT status,paid_amount FROM purchases WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [s.tenantId, id])).rows[0];
      if (!p) throw new BadRequestException('Factura no encontrada');
      if (Number(p.paid_amount) > 0) throw new BadRequestException('La factura tiene pagos registrados');
      if (p.status === 'void') throw new BadRequestException('La factura ya está anulada');
      await c.query("UPDATE purchases SET status='void' WHERE tenant_id=$1 AND id=$2", [s.tenantId, id]);
      return { ok: true };
    });
  }
}

@ApiTags('suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly db: DbService) {}
  private session(req: AuthRequest, write = false) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin', 'manager', 'cashier'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    if (write && !['admin', 'manager'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }
  @Post() async create(@Req() req: AuthRequest, @Body() b: { name: string; taxId?: string; email?: string; phone?: string; address?: string }) {
    const s = this.session(req, true);
    if (!b?.name?.trim()) throw new BadRequestException('Nombre requerido');
    return this.db.tenant(req, async c => (await c.query('INSERT INTO suppliers(tenant_id,name,tax_id,email,phone,address) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,tax_id "taxId",email,phone,address',
      [s.tenantId, b.name.trim(), b.taxId || null, b.email || null, b.phone || null, b.address || null])).rows[0]);
  }
  @Get() async list(@Req() req: AuthRequest) {
    const s = this.session(req);
    return this.db.tenant(req, async c => (await c.query('SELECT id,name,tax_id "taxId",email,phone,address FROM suppliers WHERE tenant_id=$1 AND active ORDER BY name', [s.tenantId])).rows);
  }
}
