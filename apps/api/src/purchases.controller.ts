import { BadRequestException, Body, Controller, Get, Param, Post, Req, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

@ApiTags('purchases')
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly db:DbService){}
  private manager(req:AuthRequest){const s=req.session?.app;if(!s)throw new UnauthorizedException();if(!['admin','manager'].includes(s.role))throw new ForbiddenException();return s;}
  @Post() async create(@Req() req:AuthRequest,@Body() b:{supplierId?:string;invoiceNumber?:string;purchasedAt?:string;paymentMethod?:string;vatDeductible?:boolean;lines:{ingredientId:string;quantity?:number;packages?:number;unitPriceNet?:number;vatRate?:number}[]}){
    const s=this.manager(req);if(!Array.isArray(b?.lines)||!b.lines.length)throw new BadRequestException('Añade al menos una línea de compra');
    return this.db.tenant(req,async c=>{const p=await c.query("INSERT INTO purchases(tenant_id,supplier_id,invoice_number,purchased_at,status,payment_method,vat_deductible) VALUES($1,$2,$3,$4,'draft',$5,$6) RETURNING id",[s.tenantId,b.supplierId||null,b.invoiceNumber||null,b.purchasedAt||new Date().toISOString(),b.paymentMethod||null,b.vatDeductible!==false]);let net=0,vat=0;
      for(const l of b.lines){const ingredient=await c.query('SELECT package_size,package_price_net,default_vat_rate FROM ingredients WHERE tenant_id=$1 AND id=$2 AND active',[s.tenantId,l.ingredientId]);if(!ingredient.rows[0])throw new BadRequestException('Ingrediente no disponible');const cfg=ingredient.rows[0],packageCount=l.packages,quantity=packageCount!=null?Number(packageCount)*Number(cfg.package_size):Number(l.quantity),unitPriceNet=packageCount!=null?Number(cfg.package_price_net)/Number(cfg.package_size):Number(l.unitPriceNet),vatRate=l.vatRate??Number(cfg.default_vat_rate);if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(unitPriceNet)||unitPriceNet<0||!Number.isFinite(vatRate)||vatRate<0)throw new BadRequestException('Línea de compra no válida');const n=Number((quantity*unitPriceNet).toFixed(2)),v=Number((n*vatRate/100).toFixed(2));net+=n;vat+=v;await c.query('INSERT INTO purchase_lines(tenant_id,purchase_id,ingredient_id,quantity,package_count,unit_price_net,vat_rate,line_net,line_vat,line_gross) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[s.tenantId,p.rows[0].id,l.ingredientId,quantity,packageCount??null,unitPriceNet,vatRate,n,v,n+v]);}
      await c.query('UPDATE purchases SET net_total=$3,vat_total=$4,gross_total=$3+$4 WHERE tenant_id=$1 AND id=$2',[s.tenantId,p.rows[0].id,net,vat]);return{id:p.rows[0].id,status:'draft',netTotal:net,vatTotal:vat,grossTotal:net+vat};});
  }
  @Post(':id/receive') async receive(@Req() req:AuthRequest,@Param('id') id:string){const s=this.manager(req);return this.db.tenant(req,async c=>{const p=await c.query("SELECT status FROM purchases WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[s.tenantId,id]);if(!p.rows[0]||p.rows[0].status!=='draft')throw new BadRequestException('Factura inexistente o ya recibida');const lines=await c.query('SELECT ingredient_id,sum(quantity) quantity,sum(quantity*unit_price_net)/nullif(sum(quantity),0) unit_cost FROM purchase_lines WHERE tenant_id=$1 AND purchase_id=$2 GROUP BY ingredient_id',[s.tenantId,id]);for(const l of lines.rows){await c.query(`UPDATE ingredients SET current_unit_cost=CASE WHEN current_stock+$3>0 THEN (current_stock*current_unit_cost+$3*$4)/(current_stock+$3) ELSE $4 END,current_stock=current_stock+$3 WHERE tenant_id=$1 AND id=$2`,[s.tenantId,l.ingredient_id,l.quantity,l.unit_cost]);await c.query("INSERT INTO stock_movements(tenant_id,ingredient_id,movement_type,quantity_delta,unit_cost,source_type,source_id,created_by) VALUES($1,$2,'purchase',$3,$4,'purchase',$5,$6)",[s.tenantId,l.ingredient_id,l.quantity,l.unit_cost,id,s.userId]);}await c.query("UPDATE purchases SET status='received' WHERE tenant_id=$1 AND id=$2",[s.tenantId,id]);return{ok:true,receivedLines:lines.rowCount};});}
}

@ApiTags('suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly db:DbService){}
  private manager(req:AuthRequest){const s=req.session?.app;if(!s)throw new UnauthorizedException();if(!['admin','manager'].includes(s.role))throw new ForbiddenException();return s;}
  @Post() async create(@Req() req:AuthRequest,@Body() b:{name:string;taxId?:string;email?:string;phone?:string;address?:string}){const s=this.manager(req);if(!b?.name)throw new BadRequestException('Nombre requerido');return this.db.tenant(req,async c=>(await c.query('INSERT INTO suppliers(tenant_id,name,tax_id,email,phone,address) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,tax_id "taxId",email,phone,address',[s.tenantId,b.name,b.taxId||null,b.email||null,b.phone||null,b.address||null])).rows[0]);}
  @Get() async list(@Req() req:AuthRequest){const s=this.manager(req);return this.db.tenant(req,async c=>(await c.query('SELECT id,name,tax_id "taxId",email,phone,address FROM suppliers WHERE tenant_id=$1 AND active ORDER BY name',[s.tenantId])).rows);}
}
