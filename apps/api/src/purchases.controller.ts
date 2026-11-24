import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Req, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

@ApiTags('purchases')
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly db:DbService){}
  private manager(req:AuthRequest){const s=req.session?.app;if(!s)throw new UnauthorizedException();if(!['admin','manager'].includes(s.role))throw new ForbiddenException();return s;}
  @Post() async create(@Req() req:AuthRequest,@Body() b:{supplierId?:string;invoiceNumber?:string;purchasedAt?:string;paymentMethod?:string;vatDeductible?:boolean;lines:{ingredientId:string;quantity?:number;packages?:number;unitPriceNet?:number;packagePriceNet?:number;vatRate?:number}[]}){
    const s=this.manager(req);if(!Array.isArray(b?.lines)||!b.lines.length)throw new BadRequestException('Añade al menos una línea de compra');
    return this.db.tenant(req,async c=>{if(b.supplierId){const supplier=await c.query('SELECT 1 FROM suppliers WHERE tenant_id=$1 AND id=$2 AND active',[s.tenantId,b.supplierId]);if(!supplier.rowCount)throw new BadRequestException('Proveedor no disponible');}const p=await c.query("INSERT INTO purchases(tenant_id,supplier_id,invoice_number,purchased_at,status,payment_method,vat_deductible) VALUES($1,$2,$3,$4,'draft',$5,$6) RETURNING id",[s.tenantId,b.supplierId||null,b.invoiceNumber||null,b.purchasedAt||new Date().toISOString(),b.paymentMethod||null,b.vatDeductible!==false]);let net=0,vat=0;
      for(const l of b.lines){const ingredient=await c.query('SELECT package_size,package_price_net,default_vat_rate,supplier_id FROM ingredients WHERE tenant_id=$1 AND id=$2 AND active',[s.tenantId,l.ingredientId]);if(!ingredient.rows[0])throw new BadRequestException('Ingrediente no disponible');const cfg=ingredient.rows[0];if(String(cfg.supplier_id||'')!==String(b.supplierId||''))throw new BadRequestException('La compra solo puede contener productos del proveedor asignado');const packageCount=l.packages,quantity=packageCount!=null?Number(packageCount)*Number(cfg.package_size):Number(l.quantity),unitPriceNet=packageCount!=null?Number(l.packagePriceNet??cfg.package_price_net)/Number(cfg.package_size):Number(l.unitPriceNet),vatRate=l.vatRate??Number(cfg.default_vat_rate);if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(unitPriceNet)||unitPriceNet<0||!Number.isFinite(vatRate)||vatRate<0)throw new BadRequestException('Línea de compra no válida');const n=Number((quantity*unitPriceNet).toFixed(2)),v=Number((n*vatRate/100).toFixed(2));net+=n;vat+=v;await c.query('INSERT INTO purchase_lines(tenant_id,purchase_id,ingredient_id,quantity,package_count,unit_price_net,vat_rate,line_net,line_vat,line_gross) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[s.tenantId,p.rows[0].id,l.ingredientId,quantity,packageCount??null,unitPriceNet,vatRate,n,v,n+v]);}
      await c.query('UPDATE purchases SET net_total=$3,vat_total=$4,gross_total=$3+$4 WHERE tenant_id=$1 AND id=$2',[s.tenantId,p.rows[0].id,net,vat]);return{id:p.rows[0].id,status:'draft',netTotal:net,vatTotal:vat,grossTotal:net+vat};});
  }
  @Get() async list(@Req() req:AuthRequest){const s=this.manager(req);return this.db.tenant(req,async c=>(await c.query(`SELECT p.id,p.supplier_id "supplierId",sp.name "supplierName",p.purchased_at "purchasedAt",p.status,p.net_total "netTotal",p.gross_total "grossTotal",p.received_gross_total "receivedGrossTotal",count(pl.id)::int "lineCount" FROM purchases p LEFT JOIN suppliers sp ON sp.tenant_id=p.tenant_id AND sp.id=p.supplier_id LEFT JOIN purchase_lines pl ON pl.tenant_id=p.tenant_id AND pl.purchase_id=p.id WHERE p.tenant_id=$1 GROUP BY p.id,sp.name ORDER BY p.purchased_at DESC LIMIT 100`,[s.tenantId])).rows);}
  @Get(':id') async detail(@Req() req:AuthRequest,@Param('id') id:string){const s=this.manager(req);return this.db.tenant(req,async c=>{const p=(await c.query(`SELECT p.id,p.supplier_id "supplierId",sp.name "supplierName",p.purchased_at "purchasedAt",p.status,p.net_total "netTotal",p.gross_total "grossTotal",p.received_gross_total "receivedGrossTotal" FROM purchases p LEFT JOIN suppliers sp ON sp.tenant_id=p.tenant_id AND sp.id=p.supplier_id WHERE p.tenant_id=$1 AND p.id=$2`,[s.tenantId,id])).rows[0];if(!p)throw new BadRequestException('Pedido no encontrado');p.lines=(await c.query(`SELECT pl.id,pl.ingredient_id "ingredientId",i.name,pl.quantity,pl.received_quantity "receivedQuantity",pl.receipt_note "receiptNote",pl.unit_price_net "unitPriceNet",pl.vat_rate "vatRate" FROM purchase_lines pl JOIN ingredients i ON i.tenant_id=pl.tenant_id AND i.id=pl.ingredient_id WHERE pl.tenant_id=$1 AND pl.purchase_id=$2 ORDER BY i.name`,[s.tenantId,id])).rows;return p;});}
  @Post(':id/receive') async receive(@Req() req:AuthRequest,@Param('id') id:string,@Body() b:{lines?:{lineId:string;quantity:number;note?:string}[]}){
    const s=this.manager(req);
    return this.db.tenant(req,async c=>{
      const purchase=(await c.query("SELECT status,supplier_id FROM purchases WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[s.tenantId,id])).rows[0];
      if(!purchase||!['draft','partially_received'].includes(purchase.status))throw new BadRequestException('Pedido inexistente, cancelado o ya recibido');
      const lines=(await c.query('SELECT id,ingredient_id,quantity,received_quantity,receipt_note,unit_price_net,vat_rate FROM purchase_lines WHERE tenant_id=$1 AND purchase_id=$2 FOR UPDATE',[s.tenantId,id])).rows;
      const requested=b?.lines;
      if(requested!==undefined&&(!Array.isArray(requested)||!requested.length))throw new BadRequestException('Indica al menos una línea que recibir');if(requested&&new Set(requested.map(line=>line.lineId)).size!==requested.length)throw new BadRequestException('No repitas líneas en la recepción');
      const receivedMap=new Map((requested||[]).map(line=>[line.lineId,{quantity:Number(line.quantity),note:String(line.note||'').trim()}]));
      let receivedNet=0,receivedVat=0,receivedLines=0;
      for(const line of lines){
        const remaining=Number(line.quantity)-Number(line.received_quantity);
        const entry=receivedMap.get(line.id);const quantity=requested===undefined?remaining:(entry?.quantity??0);
        if(quantity===0)continue;
        if(!Number.isFinite(quantity)||quantity<0||quantity>remaining)throw new BadRequestException('La cantidad recibida supera lo pendiente o no es válida');
        const ingredient=(await c.query('SELECT current_stock,current_unit_cost FROM ingredients WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenantId,line.ingredient_id])).rows[0];
        if(!ingredient)throw new BadRequestException('Artículo de inventario no disponible');
        const cost=Number(line.unit_price_net),stock=Number(ingredient.current_stock),oldCost=Number(ingredient.current_unit_cost),newStock=stock+quantity;
        await c.query('UPDATE ingredients SET current_unit_cost=CASE WHEN $3>0 THEN ($4*$5+$6*$7)/$3 ELSE $7 END,current_stock=$3 WHERE tenant_id=$1 AND id=$2',[s.tenantId,line.ingredient_id,newStock,stock,oldCost,quantity,cost]);
        await c.query(`UPDATE purchase_lines SET received_quantity=received_quantity+$3,receipt_note=CASE WHEN $4='' THEN receipt_note ELSE concat_ws(chr(10),nullif(receipt_note,''),$4) END WHERE tenant_id=$1 AND id=$2`,[s.tenantId,line.id,quantity,entry?.note||'']);
        await c.query("INSERT INTO stock_movements(tenant_id,ingredient_id,movement_type,quantity_delta,unit_cost,source_type,source_id,created_by) VALUES($1,$2,'purchase',$3,$4,'purchase',$5,$6)",[s.tenantId,line.ingredient_id,quantity,cost,id,s.userId]);
        const net=Number((quantity*cost).toFixed(2)),vat=Number((net*Number(line.vat_rate)/100).toFixed(2));receivedNet+=net;receivedVat+=vat;receivedLines++;
      }
      if(requested)for(const lineId of receivedMap.keys())if(!lines.some(line=>line.id===lineId))throw new BadRequestException('La línea no pertenece a este pedido');
      if(!receivedLines)throw new BadRequestException('No quedan cantidades pendientes por recibir');
      const pending=(await c.query('SELECT count(*)::int count FROM purchase_lines WHERE tenant_id=$1 AND purchase_id=$2 AND received_quantity<quantity',[s.tenantId,id])).rows[0].count;
      const status=Number(pending)===0?'received':'partially_received';
      await c.query(`UPDATE purchases SET status=$3,received_net_total=received_net_total+$4,received_vat_total=received_vat_total+$5,received_gross_total=received_gross_total+$4+$5 WHERE tenant_id=$1 AND id=$2`,[s.tenantId,id,status,receivedNet,receivedVat]);
      return{ok:true,status,receivedLines,receivedNet,receivedVat,receivedGross:receivedNet+receivedVat};
    });
  }
  @Post(':id/cancel') async cancel(@Req() req:AuthRequest,@Param('id') id:string){const s=this.manager(req);return this.db.tenant(req,async c=>{const r=await c.query("UPDATE purchases SET status='void' WHERE tenant_id=$1 AND id=$2 AND status IN ('draft','partially_received') RETURNING id",[s.tenantId,id]);if(!r.rowCount)throw new BadRequestException('Solo se pueden cancelar pedidos pendientes');return{ok:true};});}
}

@ApiTags('suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly db:DbService){}
  private manager(req:AuthRequest){const s=req.session?.app;if(!s)throw new UnauthorizedException();if(!['admin','manager'].includes(s.role))throw new ForbiddenException();return s;}
  @Post() async create(@Req() req:AuthRequest,@Body() b:{name:string;taxId?:string;email?:string;phone?:string;address?:string;paymentTerms?:string}){const s=this.manager(req);const name=String(b?.name||'').trim();if(!name)throw new BadRequestException('Nombre requerido');return this.db.tenant(req,async c=>(await c.query('INSERT INTO suppliers(tenant_id,name,tax_id,email,phone,address,payment_terms) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,tax_id "taxId",email,phone,address,payment_terms "paymentTerms"',[s.tenantId,name,b.taxId?.trim()||null,b.email?.trim()||null,b.phone?.trim()||null,b.address?.trim()||null,b.paymentTerms?.trim()||null])).rows[0]);}
  @Get() async list(@Req() req:AuthRequest){const s=this.manager(req);return this.db.tenant(req,async c=>(await c.query('SELECT id,name,tax_id "taxId",email,phone,address,payment_terms "paymentTerms" FROM suppliers WHERE tenant_id=$1 AND active ORDER BY name',[s.tenantId])).rows);}
  @Patch(':id') async update(@Req() req:AuthRequest,@Param('id') id:string,@Body() b:{name?:string;taxId?:string|null;email?:string|null;phone?:string|null;address?:string|null;paymentTerms?:string|null}){const s=this.manager(req);if(b.name!==undefined&&!b.name.trim())throw new BadRequestException('Nombre requerido');return this.db.tenant(req,async c=>{const r=await c.query(`UPDATE suppliers SET name=coalesce($3,name),tax_id=CASE WHEN $4 THEN $5 ELSE tax_id END,email=CASE WHEN $6 THEN $7 ELSE email END,phone=CASE WHEN $8 THEN $9 ELSE phone END,address=CASE WHEN $10 THEN $11 ELSE address END,payment_terms=CASE WHEN $12 THEN $13 ELSE payment_terms END WHERE tenant_id=$1 AND id=$2 AND active RETURNING id,name,tax_id "taxId",email,phone,address,payment_terms "paymentTerms"`,[s.tenantId,id,b.name?.trim()??null,b.taxId!==undefined,b.taxId??null,b.email!==undefined,b.email??null,b.phone!==undefined,b.phone??null,b.address!==undefined,b.address??null,b.paymentTerms!==undefined,b.paymentTerms??null]);if(!r.rowCount)throw new BadRequestException('Proveedor no encontrado');return r.rows[0];});}
  @Delete(':id') async remove(@Req() req:AuthRequest,@Param('id') id:string){const s=this.manager(req);return this.db.tenant(req,async c=>{const linked=await c.query('SELECT 1 FROM ingredients WHERE tenant_id=$1 AND supplier_id=$2 AND active LIMIT 1',[s.tenantId,id]);if(linked.rowCount)throw new BadRequestException('Asigna otro proveedor a sus ingredientes antes de desactivarlo');const r=await c.query('UPDATE suppliers SET active=false WHERE tenant_id=$1 AND id=$2 AND active RETURNING id',[s.tenantId,id]);if(!r.rowCount)throw new BadRequestException('Proveedor no encontrado');return{ok:true};});}
}
