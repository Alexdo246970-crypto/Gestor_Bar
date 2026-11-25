import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

type PurchaseLineBody = { ingredientId?: string; description?: string; quantity?: number; packages?: number; packagePriceNet?: number; unitPriceNet?: number; vatRate?: number };
type PurchaseBody = {
  supplierId?: string; invoiceNumber?: string; purchasedAt?: string; invoiceDate?: string; dueDate?: string;
  paymentMethod?: string; vatDeductible?: boolean; notes?: string; lines?: PurchaseLineBody[];
};
type PaymentBody = { amount: number; method?: string; account?: 'cash' | 'bank'; reference?: string };
type ReceiveBody = { lines?: { lineId: string; quantity: number; note?: string }[] };

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

  private async checkSupplier(c: any, tenant: string, supplierId?: string | null) {
    if (!supplierId) return;
    const supplier = await c.query('SELECT 1 FROM suppliers WHERE tenant_id=$1 AND id=$2 AND active', [tenant, supplierId]);
    if (!supplier.rowCount) throw new BadRequestException('Proveedor no disponible');
  }

  private async lines(c: any, tenant: string, purchaseId: string, lines: PurchaseLineBody[], supplierId?: string | null) {
    if (!Array.isArray(lines) || !lines.length) throw new BadRequestException('Añade al menos una línea de compra');
    if (new Set(lines.map(l => l.ingredientId || l.description)).size !== lines.length) throw new BadRequestException('No repitas artículos en el mismo pedido');
    await c.query('DELETE FROM purchase_lines WHERE tenant_id=$1 AND purchase_id=$2', [tenant, purchaseId]);
    let net = 0, vat = 0;
    for (const l of lines) {
      const description = l.description?.trim() || null;
      const ingredientId = l.ingredientId?.trim() || null;
      if (!!ingredientId === !!description) throw new BadRequestException('Cada línea debe indicar un ingrediente o una descripción libre');
      let quantity = num(l.quantity, 1), unitPriceNet = num(l.unitPriceNet), vatRate = num(l.vatRate, 21), packageCount: number | null = null;
      if (ingredientId) {
        const cfg = (await c.query('SELECT package_size,package_price_net,default_vat_rate,supplier_id FROM ingredients WHERE tenant_id=$1 AND id=$2 AND active', [tenant, ingredientId])).rows[0];
        if (!cfg) throw new BadRequestException('Ingrediente no disponible');
        if (supplierId && String(cfg.supplier_id || '') !== String(supplierId)) {
          const available = await c.query('SELECT 1 FROM supplier_item_prices WHERE tenant_id=$1 AND ingredient_id=$2 AND supplier_id=$3 LIMIT 1', [tenant, ingredientId, supplierId]);
          if (!available.rowCount) throw new BadRequestException('El proveedor no tiene tarifa asignada para este artículo');
        }
        packageCount = l.packages === undefined ? null : num(l.packages);
        quantity = packageCount !== null ? packageCount * Number(cfg.package_size) : num(l.quantity);
        unitPriceNet = packageCount !== null ? num(l.packagePriceNet ?? cfg.package_price_net) / Number(cfg.package_size) : num(l.unitPriceNet);
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

  private async detail(c: any, tenant: string, id: string) {
    const header = (await c.query(`SELECT p.id,p.supplier_id "supplierId",s.name "supplierName",p.invoice_number "invoiceNumber",
        p.purchased_at "purchasedAt",p.invoice_date "invoiceDate",p.due_date "dueDate",p.status,
        p.payment_status "paymentStatus",p.paid_amount "paidAmount",p.payment_method "paymentMethod",
        p.vat_deductible "vatDeductible",p.net_total "netTotal",p.vat_total "vatTotal",p.gross_total "grossTotal",
        p.received_gross_total "receivedGrossTotal",p.notes,p.gross_total-p.paid_amount "pendingAmount"
      FROM purchases p LEFT JOIN suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id
      WHERE p.tenant_id=$1 AND p.id=$2`, [tenant, id])).rows[0];
    if (!header) throw new BadRequestException('Pedido no encontrado');
    const lines = (await c.query(`SELECT l.id,l.description,l.ingredient_id "ingredientId",i.name "ingredientName",l.quantity,
        l.received_quantity "receivedQuantity",l.receipt_note "receiptNote",l.package_count "packageCount",
        l.unit_price_net "unitPriceNet",l.vat_rate "vatRate",l.line_net "lineNet",l.line_vat "lineVat",l.line_gross "lineGross"
      FROM purchase_lines l LEFT JOIN ingredients i ON i.tenant_id=l.tenant_id AND i.id=l.ingredient_id
      WHERE l.tenant_id=$1 AND l.purchase_id=$2 ORDER BY l.description NULLS LAST,i.name NULLS LAST`, [tenant, id])).rows;
    const payments = (await c.query(`SELECT id,amount,method,account,reference,paid_at "paidAt" FROM purchase_payments
      WHERE tenant_id=$1 AND purchase_id=$2 ORDER BY paid_at`, [tenant, id])).rows;
    return { ...header, lines, payments };
  }

  /** Listado con filtros por fecha de factura, proveedor, estado de recepción o estado de pago. */
  @Get() async list(@Req() req: AuthRequest, @Query('from') from?: string, @Query('to') to?: string,
                    @Query('supplierId') supplierId?: string, @Query('status') status?: string) {
    const s = this.session(req);
    return this.db.tenant(req, async c => {
      const filter = status && ['pending', 'partial', 'paid'].includes(status) ? 'p.payment_status' : 'p.status';
      const rows = (await c.query(`SELECT p.id,p.supplier_id "supplierId",p.invoice_number "invoiceNumber",p.purchased_at "purchasedAt",
          p.invoice_date "invoiceDate",p.due_date "dueDate",p.status,p.payment_status "paymentStatus",p.paid_amount "paidAmount",
          p.gross_total "grossTotal",p.received_gross_total "receivedGrossTotal",p.gross_total-p.paid_amount "pendingAmount",
          p.vat_deductible "vatDeductible",s.name "supplierName",
          (SELECT count(*)::int FROM purchase_lines l WHERE l.tenant_id=p.tenant_id AND l.purchase_id=p.id) "lineCount"
        FROM purchases p LEFT JOIN suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id
        WHERE p.tenant_id=$1 AND ($2::date IS NULL OR p.invoice_date >= $2::date)
          AND ($3::date IS NULL OR p.invoice_date <= $3::date)
          AND ($4::uuid IS NULL OR p.supplier_id=$4::uuid)
          AND ($5::text IS NULL OR ${filter}=$5)
        ORDER BY p.invoice_date DESC,p.id DESC LIMIT 500`,
        [s.tenantId, from || null, to || null, supplierId || null, status || null])).rows;
      const totals = rows.reduce((acc: any, r: any) => {
        acc.gross += Number(r.grossTotal); acc.paid += Number(r.paidAmount); acc.pending += Number(r.pendingAmount);
        return acc;
      }, { gross: 0, paid: 0, pending: 0 });
      return { lines: rows, totals: { gross: round(totals.gross), paid: round(totals.paid), pending: round(totals.pending) } };
    });
  }

  @Get('last-price/:ingredientId') async lastPrice(@Req() req: AuthRequest, @Param('ingredientId') ingredientId: string) {
    const s = this.session(req);
    return this.db.tenant(req, async c => {
      const row = (await c.query(`SELECT p.supplier_id "supplierId",(pl.unit_price_net*i.package_size) "packagePriceNet",pl.vat_rate "vatRate",p.purchased_at "purchasedAt"
        FROM purchase_lines pl JOIN purchases p ON p.tenant_id=pl.tenant_id AND p.id=pl.purchase_id
        JOIN ingredients i ON i.tenant_id=pl.tenant_id AND i.id=pl.ingredient_id
        WHERE pl.tenant_id=$1 AND pl.ingredient_id=$2 AND p.status IN ('received','partially_received')
        ORDER BY p.purchased_at DESC LIMIT 1`, [s.tenantId, ingredientId])).rows[0];
      return row || null;
    });
  }

  @Get(':id') async get(@Req() req: AuthRequest, @Param('id') id: string) {
    this.session(req);
    return this.db.tenant(req, async c => this.detail(c, req.session!.app!.tenantId, id));
  }

  @Post() async create(@Req() req: AuthRequest, @Body() b: PurchaseBody) {
    const s = this.session(req, true);
    const purchasedAt = b.purchasedAt || new Date().toISOString();
    const invoiceDate = b.invoiceDate || purchasedAt.slice(0, 10);
    if (Number.isNaN(Date.parse(invoiceDate))) throw new BadRequestException('Fecha de factura no válida');
    return this.db.tenant(req, async c => {
      await this.checkSupplier(c, s.tenantId, b.supplierId);
      const p = (await c.query(`INSERT INTO purchases
          (tenant_id,supplier_id,invoice_number,purchased_at,invoice_date,due_date,status,payment_method,vat_deductible,notes)
          VALUES($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9) RETURNING id`,
          [s.tenantId, b.supplierId || null, b.invoiceNumber?.trim() || null, purchasedAt, invoiceDate, b.dueDate || null,
            b.paymentMethod || null, b.vatDeductible !== false, b.notes?.trim() || null])).rows[0];
      await this.lines(c, s.tenantId, p.id, b.lines || [], b.supplierId);
      return this.detail(c, s.tenantId, p.id);
    });
  }

  @Patch(':id') async update(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: PurchaseBody) {
    const s = this.session(req, true);
    if (b.invoiceDate && Number.isNaN(Date.parse(b.invoiceDate))) throw new BadRequestException('Fecha de factura no válida');
    return this.db.tenant(req, async c => {
      const p = (await c.query("SELECT status,supplier_id FROM purchases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [s.tenantId, id])).rows[0];
      if (!p) throw new BadRequestException('Pedido no encontrado');
      if (p.status !== 'draft') throw new BadRequestException('Solo se pueden editar pedidos en borrador');
      const supplierId = b.supplierId === undefined ? p.supplier_id : b.supplierId || null;
      await this.checkSupplier(c, s.tenantId, supplierId);
      await c.query(`UPDATE purchases SET supplier_id=$3,invoice_number=coalesce($4,invoice_number),
          invoice_date=coalesce($5,invoice_date),due_date=coalesce($6,due_date),payment_method=coalesce($7,payment_method),
          vat_deductible=coalesce($8,vat_deductible),notes=coalesce($9,notes)
        WHERE tenant_id=$1 AND id=$2`,
        [s.tenantId, id, supplierId, b.invoiceNumber?.trim() || null, b.invoiceDate || null, b.dueDate || null,
          b.paymentMethod || null, b.vatDeductible ?? null, b.notes?.trim() || null]);
      if (b.lines) await this.lines(c, s.tenantId, id, b.lines, supplierId);
      return this.detail(c, s.tenantId, id);
    });
  }

  @Post(':id/duplicate') async duplicate(@Req() req: AuthRequest, @Param('id') id: string) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const source = (await c.query('SELECT supplier_id,invoice_date,due_date,payment_method,vat_deductible,notes FROM purchases WHERE tenant_id=$1 AND id=$2', [s.tenantId, id])).rows[0];
      if (!source) throw new BadRequestException('Pedido no encontrado');
      const lines = (await c.query(`SELECT ingredient_id,description,quantity,package_count,unit_price_net,vat_rate
        FROM purchase_lines WHERE tenant_id=$1 AND purchase_id=$2`, [s.tenantId, id])).rows;
      if (!lines.length) throw new BadRequestException('El pedido no tiene líneas');
      const created = (await c.query(`INSERT INTO purchases(tenant_id,supplier_id,purchased_at,invoice_date,due_date,payment_method,vat_deductible,notes,status)
        VALUES($1,$2,now(),$3,$4,$5,$6,$7,'draft') RETURNING id`,
        [s.tenantId, source.supplier_id, source.invoice_date, source.due_date, source.payment_method, source.vat_deductible, source.notes])).rows[0];
      let net = 0, vat = 0;
      for (const l of lines) {
        const n = Number((Number(l.quantity) * Number(l.unit_price_net)).toFixed(2)), v = Number((n * Number(l.vat_rate) / 100).toFixed(2));
        net += n; vat += v;
        await c.query(`INSERT INTO purchase_lines(tenant_id,purchase_id,ingredient_id,description,quantity,package_count,unit_price_net,vat_rate,line_net,line_vat,line_gross)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [s.tenantId, created.id, l.ingredient_id, l.description, l.quantity, l.package_count, l.unit_price_net, l.vat_rate, n, v, n + v]);
      }
      await c.query('UPDATE purchases SET net_total=$3,vat_total=$4,gross_total=$3+$4 WHERE tenant_id=$1 AND id=$2', [s.tenantId, created.id, net, vat]);
      return this.detail(c, s.tenantId, created.id);
    });
  }

  /** Recibe la mercancía (total o parcialmente), actualiza stock y registra el gasto una sola vez. */
  @Post(':id/receive') async receive(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: ReceiveBody) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const p = (await c.query('SELECT * FROM purchases WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [s.tenantId, id])).rows[0];
      if (!p || !['draft', 'partially_received'].includes(p.status)) throw new BadRequestException('Pedido inexistente, cancelado o ya recibido');
      const lines = (await c.query(`SELECT pl.id,pl.ingredient_id "ingredientId",pl.description,pl.quantity,
          pl.received_quantity "receivedQuantity",pl.receipt_note "receiptNote",pl.unit_price_net "unitPriceNet",pl.vat_rate "vatRate"
        FROM purchase_lines pl WHERE pl.tenant_id=$1 AND pl.purchase_id=$2 FOR UPDATE`, [s.tenantId, id])).rows;
      const requested = b?.lines;
      if (requested !== undefined && (!Array.isArray(requested) || !requested.length)) throw new BadRequestException('Indica al menos una línea que recibir');
      if (requested && new Set(requested.map(line => line.lineId)).size !== requested.length) throw new BadRequestException('No repitas líneas en la recepción');
      const receivedMap = new Map((requested || []).map(line => [line.lineId, { quantity: Number(line.quantity), note: String(line.note || '').trim() }]));
      let receivedNet = 0, receivedVat = 0, receivedLines = 0;
      for (const line of lines) {
        if (!line.ingredientId) continue; // Las líneas libres no mueven inventario.
        const remaining = Number(line.quantity) - Number(line.receivedQuantity);
        const entry = receivedMap.get(line.id);
        const quantity = requested === undefined ? remaining : (entry?.quantity ?? 0);
        if (quantity === 0) continue;
        if (!Number.isFinite(quantity) || quantity < 0 || quantity > remaining) throw new BadRequestException('La cantidad recibida supera lo pendiente o no es válida');
        const ingredient = (await c.query('SELECT current_stock,current_unit_cost FROM ingredients WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [s.tenantId, line.ingredientId])).rows[0];
        if (!ingredient) throw new BadRequestException('Artículo de inventario no disponible');
        const cost = Number(line.unitPriceNet), stock = Number(ingredient.current_stock), oldCost = Number(ingredient.current_unit_cost), newStock = stock + quantity;
        await c.query('UPDATE ingredients SET current_unit_cost=CASE WHEN $3>0 THEN ($4*$5+$6*$7)/$3 ELSE $7 END,current_stock=$3 WHERE tenant_id=$1 AND id=$2',
          [s.tenantId, line.ingredientId, newStock, stock, oldCost, quantity, cost]);
        await c.query(`UPDATE purchase_lines SET received_quantity=received_quantity+$3,receipt_note=CASE WHEN $4='' THEN receipt_note ELSE concat_ws(chr(10),nullif(receipt_note,''),$4) END WHERE tenant_id=$1 AND id=$2`,
          [s.tenantId, line.id, quantity, entry?.note || '']);
        await c.query(`INSERT INTO stock_movements(tenant_id,ingredient_id,movement_type,quantity_delta,unit_cost,source_type,source_id,created_by)
          VALUES($1,$2,'purchase',$3,$4,'purchase',$5,$6)`, [s.tenantId, line.ingredientId, quantity, cost, id, s.userId]);
        const net = round(quantity * cost), vat = round(net * Number(line.vatRate) / 100);
        receivedNet += net; receivedVat += vat; receivedLines++;
      }
      if (requested) for (const lineId of receivedMap.keys()) if (!lines.some(line => line.id === lineId)) throw new BadRequestException('La línea no pertenece a este pedido');
      if (!receivedLines) throw new BadRequestException('No quedan cantidades pendientes por recibir');
      const pending = Number((await c.query('SELECT count(*)::int count FROM purchase_lines WHERE tenant_id=$1 AND purchase_id=$2 AND ingredient_id IS NOT NULL AND received_quantity<quantity', [s.tenantId, id])).rows[0].count);
      const status = pending === 0 ? 'received' : 'partially_received';
      await c.query(`UPDATE purchases SET status=$3,received_net_total=received_net_total+$4,received_vat_total=received_vat_total+$5,received_gross_total=received_gross_total+$4+$5 WHERE tenant_id=$1 AND id=$2`,
        [s.tenantId, id, status, round(receivedNet), round(receivedVat)]);
      if (status === 'received') {
        const deductible = p.vat_deductible !== false;
        const vat = deductible ? Number(p.vat_total) : 0;
        await c.query(`INSERT INTO ledger_entries(tenant_id,entry_date,entry_type,category,account,amount_net,vat,total,source_type,source_id,reference,notes,created_by)
          VALUES($1,$2,'expense','compras',$3,$4,$5,$6,'purchase',$7,$8,$9,$10)
          ON CONFLICT (tenant_id,source_type,source_id,account) DO NOTHING`,
          [s.tenantId, p.invoice_date, p.payment_method === 'card' ? 'bank' : 'cash', p.net_total, vat, round(Number(p.net_total) + vat),
            id, p.invoice_number, deductible ? null : 'IVA no deducible', s.userId]);
      }
      return { ok: true, status, receivedLines, receivedNet: round(receivedNet), receivedVat: round(receivedVat), receivedGross: round(receivedNet + receivedVat), ledgerEntry: status === 'received' };
    });
  }

  /** Pagos totales o parciales; el gasto contable ya se registró al recibir. */
  @Post(':id/payments') async pay(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: PaymentBody) {
    const s = this.session(req, true);
    const amount = num(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Importe de pago no válido');
    return this.db.tenant(req, async c => {
      const p = (await c.query('SELECT status,payment_method,paid_amount,gross_total FROM purchases WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [s.tenantId, id])).rows[0];
      if (!p || p.status !== 'received') throw new BadRequestException('Solo se pueden pagar pedidos recibidos');
      if (Number(p.paid_amount) + amount > Number(p.gross_total) + 0.01) throw new BadRequestException('El pago supera el total del pedido');
      const account = b.account || (b.method === 'card' || p.payment_method === 'card' ? 'bank' : 'cash');
      if (!['cash', 'bank'].includes(account)) throw new BadRequestException('Cuenta no válida');
      await c.query(`INSERT INTO purchase_payments(tenant_id,purchase_id,amount,method,account,reference,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [s.tenantId, id, amount, b.method || p.payment_method || 'cash', account, b.reference?.trim() || null, s.userId]);
      const paid = round(Number(p.paid_amount) + amount);
      const paymentStatus = paid + 0.001 >= Number(p.gross_total) ? 'paid' : 'partial';
      await c.query('UPDATE purchases SET paid_amount=$3,payment_status=$4 WHERE tenant_id=$1 AND id=$2', [s.tenantId, id, paid, paymentStatus]);
      // El saldo pendiente deja de comprometer tesorería a medida que se paga.
      await c.query(`UPDATE treasury_commitments SET amount=$3,paid=$4,paid_at=CASE WHEN $4 THEN now() ELSE paid_at END
        WHERE tenant_id=$1 AND source_type='purchase' AND source_id=$2 AND NOT paid`,
        [s.tenantId, id, Math.max(0, round(Number(p.gross_total) - paid)), paymentStatus === 'paid']);
      return { paidAmount: paid, paymentStatus, pendingAmount: round(Number(p.gross_total) - paid) };
    });
  }

  @Post(':id/cancel') async cancel(@Req() req: AuthRequest, @Param('id') id: string) { return this.voidPurchase(req, id); }

  @Post(':id/void') async voidPurchase(@Req() req: AuthRequest, @Param('id') id: string) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const p = (await c.query('SELECT status,paid_amount FROM purchases WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [s.tenantId, id])).rows[0];
      if (!p) throw new BadRequestException('Pedido no encontrado');
      if (Number(p.paid_amount) > 0) throw new BadRequestException('El pedido tiene pagos registrados');
      if (p.status === 'void') throw new BadRequestException('El pedido ya está anulado');
      await c.query("UPDATE purchases SET status='void' WHERE tenant_id=$1 AND id=$2", [s.tenantId, id]);
      return { ok: true };
    });
  }
}

@ApiTags('suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly db:DbService){}
  private manager(req:AuthRequest){const s=req.session?.app;if(!s)throw new UnauthorizedException();if(!['admin','manager'].includes(s.role))throw new ForbiddenException();return s;}
  @Post() async create(@Req() req:AuthRequest,@Body() b:{name:string;taxId?:string;email?:string;phone?:string;address?:string;paymentTerms?:string;deliveryDays?:string;minimumOrder?:number|null;paymentDays?:number|null}){const s=this.manager(req);const name=String(b?.name||'').trim();if(!name)throw new BadRequestException('Nombre requerido');if(b.minimumOrder!=null&&(!Number.isFinite(b.minimumOrder)||b.minimumOrder<0)||b.paymentDays!=null&&(!Number.isInteger(b.paymentDays)||b.paymentDays<0))throw new BadRequestException('Pedido mínimo o plazo de pago no válidos');return this.db.tenant(req,async c=>(await c.query('INSERT INTO suppliers(tenant_id,name,tax_id,email,phone,address,payment_terms,delivery_days,minimum_order,payment_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,name,tax_id "taxId",email,phone,address,payment_terms "paymentTerms",delivery_days "deliveryDays",minimum_order "minimumOrder",payment_days "paymentDays"',[s.tenantId,name,b.taxId?.trim()||null,b.email?.trim()||null,b.phone?.trim()||null,b.address?.trim()||null,b.paymentTerms?.trim()||null,b.deliveryDays?.trim()||null,b.minimumOrder??null,b.paymentDays??null])).rows[0]);}
  @Get() async list(@Req() req:AuthRequest,@Query('search') search=''){const s=this.manager(req);const term=String(search||'').trim();const normalized=`%${term}%`;return this.db.tenant(req,async c=>(await c.query(`SELECT sp.id,sp.name,sp.tax_id "taxId",sp.email,sp.phone,sp.address,sp.payment_terms "paymentTerms",sp.delivery_days "deliveryDays",sp.minimum_order "minimumOrder",sp.payment_days "paymentDays" FROM suppliers sp WHERE sp.tenant_id=$1 AND sp.active AND ($2='' OR lower(translate(sp.name||' '||coalesce(sp.tax_id,''),'áéíóúüñÁÉÍÓÚÜÑ','aeiouunAEIOUUN')) LIKE lower(translate($3,'áéíóúüñÁÉÍÓÚÜÑ','aeiouunAEIOUUN')) OR EXISTS(SELECT 1 FROM ingredients i WHERE i.tenant_id=sp.tenant_id AND i.supplier_id=sp.id AND lower(translate(i.name,'áéíóúüñÁÉÍÓÚÜÑ','aeiouunAEIOUUN')) LIKE lower(translate($3,'áéíóúüñÁÉÍÓÚÜÑ','aeiouunAEIOUUN')))) ORDER BY sp.name`,[s.tenantId,term,normalized])).rows);}
  @Get(':id/items') async catalog(@Req() req:AuthRequest,@Param('id') id:string){const s=this.manager(req);return this.db.tenant(req,async c=>{const supplier=await c.query('SELECT 1 FROM suppliers WHERE tenant_id=$1 AND id=$2 AND active',[s.tenantId,id]);if(!supplier.rowCount)throw new BadRequestException('Proveedor no encontrado');return(await c.query(`SELECT i.id,i.name,i.unit,i.current_stock "currentStock",i.package_label "packageLabel",i.package_size "packageSize",coalesce(price.package_price_net,i.package_price_net) "lastPrice",price.effective_from "lastPriceDate",(i.supplier_id=$2) "preferred" FROM ingredients i LEFT JOIN LATERAL (SELECT sp.package_price_net,sp.effective_from FROM supplier_item_prices sp WHERE sp.tenant_id=i.tenant_id AND sp.ingredient_id=i.id AND sp.supplier_id=$2 ORDER BY sp.effective_from DESC LIMIT 1) price ON true WHERE i.tenant_id=$1 AND i.active AND (i.supplier_id=$2 OR price.package_price_net IS NOT NULL) ORDER BY i.name`,[s.tenantId,id])).rows;});}
  @Get(':id/purchases') async purchaseHistory(@Req() req:AuthRequest,@Param('id') id:string){const s=this.manager(req);return this.db.tenant(req,async c=>{const supplier=await c.query('SELECT 1 FROM suppliers WHERE tenant_id=$1 AND id=$2',[s.tenantId,id]);if(!supplier.rowCount)throw new BadRequestException('Proveedor no encontrado');return(await c.query(`SELECT p.id,p.invoice_number "invoiceNumber",p.purchased_at "purchasedAt",p.status,p.net_total "netTotal",p.vat_total "vatTotal",p.gross_total "grossTotal",(SELECT coalesce(json_agg(json_build_object('name',i.name,'quantity',pl.quantity,'unit',i.unit,'unitPriceNet',pl.unit_price_net) ORDER BY i.name),'[]') FROM purchase_lines pl JOIN ingredients i ON i.tenant_id=pl.tenant_id AND i.id=pl.ingredient_id WHERE pl.tenant_id=p.tenant_id AND pl.purchase_id=p.id) lines FROM purchases p WHERE p.tenant_id=$1 AND p.supplier_id=$2 AND p.purchased_at>=now()-interval '1 year' ORDER BY p.purchased_at DESC`,[s.tenantId,id])).rows;});}
  @Patch(':id') async update(@Req() req:AuthRequest,@Param('id') id:string,@Body() b:{name?:string;taxId?:string|null;email?:string|null;phone?:string|null;address?:string|null;paymentTerms?:string|null;deliveryDays?:string|null;minimumOrder?:number|null;paymentDays?:number|null}){const s=this.manager(req);if(b.name!==undefined&&!b.name.trim())throw new BadRequestException('Nombre requerido');if(b.minimumOrder!=null&&(!Number.isFinite(b.minimumOrder)||b.minimumOrder<0)||b.paymentDays!=null&&(!Number.isInteger(b.paymentDays)||b.paymentDays<0))throw new BadRequestException('Pedido mínimo o plazo de pago no válidos');return this.db.tenant(req,async c=>{const r=await c.query(`UPDATE suppliers SET name=coalesce($3,name),tax_id=CASE WHEN $4 THEN $5 ELSE tax_id END,email=CASE WHEN $6 THEN $7 ELSE email END,phone=CASE WHEN $8 THEN $9 ELSE phone END,address=CASE WHEN $10 THEN $11 ELSE address END,payment_terms=CASE WHEN $12 THEN $13 ELSE payment_terms END,delivery_days=CASE WHEN $14 THEN $15 ELSE delivery_days END,minimum_order=CASE WHEN $16 THEN $17 ELSE minimum_order END,payment_days=CASE WHEN $18 THEN $19 ELSE payment_days END WHERE tenant_id=$1 AND id=$2 AND active RETURNING id,name,tax_id "taxId",email,phone,address,payment_terms "paymentTerms",delivery_days "deliveryDays",minimum_order "minimumOrder",payment_days "paymentDays"`,[s.tenantId,id,b.name?.trim()??null,b.taxId!==undefined,b.taxId??null,b.email!==undefined,b.email??null,b.phone!==undefined,b.phone??null,b.address!==undefined,b.address??null,b.paymentTerms!==undefined,b.paymentTerms??null,b.deliveryDays!==undefined,b.deliveryDays??null,b.minimumOrder!==undefined,b.minimumOrder??null,b.paymentDays!==undefined,b.paymentDays??null]);if(!r.rowCount)throw new BadRequestException('Proveedor no encontrado');return r.rows[0];});}
  @Delete(':id') async remove(@Req() req:AuthRequest,@Param('id') id:string){const s=this.manager(req);return this.db.tenant(req,async c=>{const linked=await c.query('SELECT 1 FROM ingredients WHERE tenant_id=$1 AND supplier_id=$2 AND active LIMIT 1',[s.tenantId,id]);if(linked.rowCount)throw new BadRequestException('Asigna otro proveedor a sus artículos activos antes de desactivarlo');const open=await c.query("SELECT 1 FROM purchases WHERE tenant_id=$1 AND supplier_id=$2 AND status='draft' LIMIT 1",[s.tenantId,id]);if(open.rowCount)throw new BadRequestException('No puedes desactivar un proveedor con pedidos abiertos');const r=await c.query('UPDATE suppliers SET active=false WHERE tenant_id=$1 AND id=$2 AND active RETURNING id',[s.tenantId,id]);if(!r.rowCount)throw new BadRequestException('Proveedor no encontrado');return{ok:true};});}
}
