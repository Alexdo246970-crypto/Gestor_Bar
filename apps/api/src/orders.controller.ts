import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly db: DbService) {}
  private role(req: AuthRequest, roles: string[]) {
    const session = req.session?.app;
    if (!session) throw new UnauthorizedException();
    if (!roles.includes(session.role)) throw new ForbiddenException('Permiso insuficiente');
    return session;
  }
  /** Abre una comanda. Con `tableId` la vincula a la mesa; si la mesa ya tiene una comanda activa, devuelve esa misma. */
  @Post() async create(@Req() req: AuthRequest, @Body() b: { channel?: string; tableLabel?: string; tableId?: string }) {
    const s = this.role(req, ['admin','manager','waiter','cashier']);
    if (b?.channel && !['table','counter','delivery'].includes(b.channel)) throw new BadRequestException('Canal no válido');
    return this.db.tenant(req, async c => {
      if (b?.tableId) {
        const table = await c.query('SELECT id,label FROM dining_tables WHERE tenant_id=$1 AND id=$2 AND active FOR UPDATE', [s.tenantId,b.tableId]);
        if (!table.rows[0]) throw new BadRequestException('Mesa no encontrada');
        const existing = await c.query(`SELECT id,order_number "orderNumber",status,opened_at "openedAt",table_id "tableId",table_label "tableLabel"
          FROM orders WHERE tenant_id=$1 AND table_id=$2 AND status IN ('open','sent')`, [s.tenantId,b.tableId]);
        if (existing.rows[0]) return { ...existing.rows[0], reused: true };
        const r = await c.query(`INSERT INTO orders(tenant_id,opened_by,channel,table_id,table_label,status) VALUES($1,$2,'table',$3,$4,'open')
          RETURNING id,order_number "orderNumber",status,opened_at "openedAt",table_id "tableId",table_label "tableLabel"`, [s.tenantId,s.userId,b.tableId,table.rows[0].label]);
        return { ...r.rows[0], reused: false };
      }
      const r = await c.query(`INSERT INTO orders(tenant_id,opened_by,channel,table_label,status) VALUES($1,$2,$3,$4,'open')
        RETURNING id,order_number "orderNumber",status,opened_at "openedAt",table_id "tableId",table_label "tableLabel"`, [s.tenantId,s.userId,b?.channel||'counter',b?.tableLabel||null]);
      return { ...r.rows[0], reused: false };
    });
  }
  @Get('active') async active(@Req() req:AuthRequest){const s=this.role(req,['admin','manager','waiter','cashier']);return this.db.tenant(req,async c=>(await c.query(`SELECT o.id,o.order_number "orderNumber",o.status,o.channel,o.table_id "tableId",o.table_label "tableLabel",o.opened_at "openedAt",o.gross_total "grossTotal",count(l.id)::int "lineCount",(SELECT coalesce(sum(p.amount),0) FROM payments p WHERE p.tenant_id=o.tenant_id AND p.order_id=o.id) "paidTotal" FROM orders o LEFT JOIN order_lines l ON l.tenant_id=o.tenant_id AND l.order_id=o.id WHERE o.tenant_id=$1 AND o.status IN ('open','sent') GROUP BY o.id ORDER BY o.opened_at`,[s.tenantId])).rows);}
  @Get(':id') async detail(@Req() req:AuthRequest,@Param('id') id:string){const s=this.role(req,['admin','manager','waiter','cashier']);return this.db.tenant(req,async c=>{const order=await c.query(`SELECT id,order_number "orderNumber",status,channel,table_id "tableId",table_label "tableLabel",opened_at "openedAt",gross_total "grossTotal",(SELECT coalesce(sum(p.amount),0) FROM payments p WHERE p.tenant_id=orders.tenant_id AND p.order_id=orders.id) "paidTotal" FROM orders WHERE tenant_id=$1 AND id=$2`,[s.tenantId,id]);if(!order.rows[0])throw new BadRequestException('Pedido no encontrado');const lines=await c.query(`SELECT id,product_id "productId",product_name "productName",quantity,line_gross "lineGross" FROM order_lines WHERE tenant_id=$1 AND order_id=$2 ORDER BY id`,[s.tenantId,id]);const payments=await c.query(`SELECT id,method,amount,cash_tendered "cashTendered",change_given "changeGiven",card_reference "cardReference",paid_at "paidAt" FROM payments WHERE tenant_id=$1 AND order_id=$2 ORDER BY paid_at`,[s.tenantId,id]);return{...order.rows[0],lines:lines.rows,payments:payments.rows};});}
  @Post(':id/lines') async addLines(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: { productId: string; quantity: number; removeIngredientIds?: string[]; addedIngredients?: {ingredientId:string;quantity:number}[] }) {
    const s = this.role(req, ['admin','manager','waiter']);
    if (!b?.productId || !Number.isFinite(b.quantity) || b.quantity <= 0) throw new BadRequestException('Producto y cantidad positiva requeridos');
    return this.db.tenant(req, async c => {
      const order = await c.query('SELECT status FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [s.tenantId,id]);
      if (!order.rows[0] || !['open','sent'].includes(order.rows[0].status)) throw new BadRequestException('Pedido inexistente, cerrado o no modificable');
      const p = await c.query('SELECT id,name,price_net,vat_rate FROM products WHERE tenant_id=$1 AND id=$2 AND active', [s.tenantId,b.productId]);
      if (!p.rows[0]) throw new BadRequestException('Producto no disponible');
      const x=p.rows[0];let extraUnitNet=0;const added:{ingredientId:string;quantity:number;unitPriceNet:number}[]=[];
      for(const extra of b.addedIngredients||[]){
        if(!extra.ingredientId||!Number.isFinite(extra.quantity)||extra.quantity<=0) throw new BadRequestException('Ingrediente adicional no válido');
        const allowed=await c.query('SELECT extra_price_net FROM product_allowed_ingredients WHERE tenant_id=$1 AND product_id=$2 AND ingredient_id=$3',[s.tenantId,x.id,extra.ingredientId]);
        if(!allowed.rows[0]) throw new BadRequestException('Ese ingrediente extra no está permitido para este plato');
        const unitPriceNet=Number(allowed.rows[0].extra_price_net);extraUnitNet+=unitPriceNet;added.push({...extra,unitPriceNet});
      }
      const unitNet=Number(x.price_net)+extraUnitNet,net=unitNet*b.quantity,vat=net*Number(x.vat_rate)/100;
      const line = await c.query(`INSERT INTO order_lines(tenant_id,order_id,product_id,product_name,quantity,unit_net,vat_rate,line_net,line_vat,line_gross)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[s.tenantId,id,x.id,x.name,b.quantity,unitNet,x.vat_rate,net.toFixed(2),vat.toFixed(2),(net+vat).toFixed(2)]);
      const lineId=line.rows[0].id;
      for(const ingredientId of [...new Set(b.removeIngredientIds||[])]) {
        const base=await c.query('SELECT quantity FROM recipes WHERE tenant_id=$1 AND product_id=$2 AND ingredient_id=$3',[s.tenantId,x.id,ingredientId]);
        if(!base.rows[0]) throw new BadRequestException('No se puede quitar un ingrediente que no pertenece al plato');
        await c.query("INSERT INTO order_line_modifications(tenant_id,order_line_id,ingredient_id,action,quantity_per_unit) VALUES($1,$2,$3,'remove',$4)",[s.tenantId,lineId,ingredientId,base.rows[0].quantity]);
      }
      for(const extra of added) {
        await c.query("INSERT INTO order_line_modifications(tenant_id,order_line_id,ingredient_id,action,quantity_per_unit,unit_price_net) VALUES($1,$2,$3,'add',$4,$5)",[s.tenantId,lineId,extra.ingredientId,extra.quantity,extra.unitPriceNet]);
      }
      await c.query(`UPDATE orders SET net_total=(SELECT coalesce(sum(line_net),0) FROM order_lines WHERE tenant_id=$1 AND order_id=$2),
        vat_total=(SELECT coalesce(sum(line_vat),0) FROM order_lines WHERE tenant_id=$1 AND order_id=$2),
        gross_total=(SELECT coalesce(sum(line_gross),0) FROM order_lines WHERE tenant_id=$1 AND order_id=$2) WHERE tenant_id=$1 AND id=$2`,[s.tenantId,id]);
      return { ok:true };
    });
  }
  @Post(':id/send') async send(@Req() req: AuthRequest, @Param('id') id: string) {
    const s=this.role(req,['admin','manager','waiter']);
    return this.db.tenant(req,async c=>{
      const r=await c.query("UPDATE orders SET status='sent' WHERE tenant_id=$1 AND id=$2 AND status IN ('open','sent') RETURNING id",[s.tenantId,id]);
      if (!r.rowCount) throw new BadRequestException('El pedido no existe o ya fue enviado');
      return {ok:true,orderId:id};
    });
  }
  /** Cobro por tarjeta (datáfono TPV) o en efectivo. Admite pagos parciales; al completar el total, cierra la comanda y libera la mesa. */
  @Post(':id/payments') async payment(@Req() req: AuthRequest,@Param('id') id:string,@Body() b:{method:string;amount:number;cashTendered?:number;cardReference?:string}) {
    const s=this.role(req,['admin','manager','cashier']);
    if (!['cash','card'].includes(b?.method)) throw new BadRequestException('Forma de pago no válida: usa tarjeta (TPV) o efectivo');
    if (!Number.isFinite(b.amount)||b.amount<=0) throw new BadRequestException('Importe no válido');
    const amount=Math.round(b.amount*100)/100;
    let tendered:number|null=null,change:number|null=null;
    if (b.method==='cash') {
      tendered=b.cashTendered==null?amount:Math.round(Number(b.cashTendered)*100)/100;
      if (!Number.isFinite(tendered)||tendered+0.001<amount) throw new BadRequestException('El efectivo entregado no cubre el importe');
      change=Math.round((tendered-amount)*100)/100;
    }
    return this.db.tenant(req,async c=>{
      const o=await c.query('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenantId,id]);
      if (!o.rows[0]||!['sent','open'].includes(o.rows[0].status)) throw new BadRequestException('Pedido no cobrable');
      if (Number(o.rows[0].gross_total)<=0) throw new BadRequestException('La comanda no tiene importe que cobrar');
      const paid=await c.query('SELECT coalesce(sum(amount),0) amount FROM payments WHERE tenant_id=$1 AND order_id=$2',[s.tenantId,id]);
      if (Number(paid.rows[0].amount)+amount>Number(o.rows[0].gross_total)+0.001) throw new BadRequestException('El pago supera el total pendiente');
      await c.query('INSERT INTO payments(tenant_id,order_id,method,amount,cash_tendered,change_given,card_reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [s.tenantId,id,b.method,amount,tendered,change,b.method==='card'?(b.cardReference?.trim()||null):null,s.userId]);
      const total=Number(paid.rows[0].amount)+amount,closed=total+0.001>=Number(o.rows[0].gross_total);
      if(closed) await this.finalize(c,s.tenantId,id,s.userId);
      return {paid:total,remaining:Math.max(0,Math.round((Number(o.rows[0].gross_total)-total)*100)/100),closed,change};
    });
  }
  @Post(':id/close') async close(@Req() req:AuthRequest,@Param('id') id:string) {
    const s=this.role(req,['admin','manager','cashier']);
    return this.db.tenant(req,async c=>{
      const o=await c.query('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenantId,id]);
      if(!o.rows[0]) throw new BadRequestException('Pedido inexistente');
      const paid=await c.query('SELECT coalesce(sum(amount),0) amount FROM payments WHERE tenant_id=$1 AND order_id=$2',[s.tenantId,id]);
      if(Number(paid.rows[0].amount)+0.001<Number(o.rows[0].gross_total)) throw new BadRequestException('El pedido aún tiene saldo pendiente');
      await this.finalize(c,s.tenantId,id,s.userId); return {ok:true};
    });
  }
  private async finalize(c:any,tenant:string,id:string,user:string) {
    const ord=await c.query('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenant,id]);
    if(ord.rows[0].stock_deducted_at) return;
    const consumption=await c.query(`WITH base AS (
        SELECT r.ingredient_id, sum(greatest(r.quantity-coalesce(m.quantity_per_unit,0),0)*l.quantity) quantity
        FROM order_lines l JOIN recipes r ON r.tenant_id=l.tenant_id AND r.product_id=l.product_id
        LEFT JOIN order_line_modifications m ON m.tenant_id=l.tenant_id AND m.order_line_id=l.id AND m.ingredient_id=r.ingredient_id AND m.action='remove'
        WHERE l.tenant_id=$1 AND l.order_id=$2 GROUP BY r.ingredient_id
      ), additions AS (
        SELECT m.ingredient_id,sum(m.quantity_per_unit*l.quantity) quantity
        FROM order_lines l JOIN order_line_modifications m ON m.tenant_id=l.tenant_id AND m.order_line_id=l.id AND m.action='add'
        WHERE l.tenant_id=$1 AND l.order_id=$2 GROUP BY m.ingredient_id
      ), totals AS (SELECT ingredient_id,sum(quantity) quantity FROM (SELECT * FROM base UNION ALL SELECT * FROM additions) stock
        WHERE quantity>0 GROUP BY ingredient_id)
      SELECT totals.ingredient_id,totals.quantity,ingredients.current_unit_cost unit_cost FROM totals JOIN ingredients
        ON ingredients.tenant_id=$1 AND ingredients.id=totals.ingredient_id`,[tenant,id]);
    for(const row of consumption.rows){
      const changed=await c.query('UPDATE ingredients SET current_stock=current_stock-$3 WHERE tenant_id=$1 AND id=$2 AND current_stock >= $3',[tenant,row.ingredient_id,row.quantity]);
      if(!changed.rowCount) throw new BadRequestException('Stock insuficiente para completar el pedido');
      await c.query(`INSERT INTO stock_movements(tenant_id,ingredient_id,movement_type,quantity_delta,unit_cost,source_type,source_id,created_by)
        VALUES($1,$2,'sale',-$3,$4,'order',$5,$6)`,[tenant,row.ingredient_id,row.quantity,row.unit_cost,id,user]);
    }
    await c.query("UPDATE orders SET status='paid',closed_at=now(),stock_deducted_at=now() WHERE tenant_id=$1 AND id=$2",[tenant,id]);
  }
}
