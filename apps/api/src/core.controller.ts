import { BadRequestException, Body, Controller, Get, Post, Req, UnauthorizedException, ForbiddenException, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as argon2 from 'argon2';
import { DbService, AuthRequest } from './db.service';

@ApiTags('catalog')
@Controller()
export class CoreController {
  constructor(private readonly db: DbService) {}
  @Get('public/menu/:token') async qrMenu(@Param('token') token:string) {
    const [tenantId,secret]=token.split('.');if(!tenantId||!secret)throw new BadRequestException('Código QR no válido');return this.db.bootstrap(async c=>{await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);const table=await c.query('SELECT tenant_id,id,label FROM dining_tables WHERE tenant_id=$1 AND qr_token=$2 AND active',[tenantId,secret]);if(!table.rows[0])throw new BadRequestException('Código QR no válido');const products=await c.query(`SELECT p.id,p.name,p.description,p.price_net "priceNet",p.vat_rate "vatRate",c.name "categoryName" FROM products p LEFT JOIN categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id WHERE p.tenant_id=$1 AND p.active ORDER BY c.sort_order,p.name`,[tenantId]);return{tableId:table.rows[0].id,tableLabel:table.rows[0].label,products:products.rows}});
  }
  @Post('public/orders/:token') async qrOrder(@Param('token') token:string,@Body() b:{name:string;email?:string;items:{productId:string;quantity:number}[]}) {
    if(!b?.name?.trim()||!Array.isArray(b.items)||!b.items.length||b.items.some(i=>!i.productId||!Number.isFinite(i.quantity)||i.quantity<=0))throw new BadRequestException('Indica tu nombre y al menos un producto con cantidad válida');
    const [tenantId,secret]=token.split('.');if(!tenantId||!secret)throw new BadRequestException('Código QR no válido');return this.db.bootstrap(async c=>{await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);const table=await c.query('SELECT tenant_id,id,label FROM dining_tables WHERE tenant_id=$1 AND qr_token=$2 AND active',[tenantId,secret]);if(!table.rows[0])throw new BadRequestException('Código QR no válido');const {id:tableId,label}=table.rows[0];const order=await c.query(`INSERT INTO orders(tenant_id,opened_by,channel,table_id,table_label,customer_name,customer_email,status) VALUES($1,NULL,'qr',$2,$3,$4,$5,'open') RETURNING id,order_number "orderNumber"`,[tenantId,tableId,label,b.name.trim(),b.email?.trim()||null]);let net=0,vat=0;for(const item of b.items){const product=await c.query('SELECT id,name,price_net,vat_rate FROM products WHERE tenant_id=$1 AND id=$2 AND active',[tenantId,item.productId]);if(!product.rows[0])throw new BadRequestException('Uno de los productos ya no está disponible');const p=product.rows[0],lineNet=Number(p.price_net)*item.quantity,lineVat=lineNet*Number(p.vat_rate)/100;net+=lineNet;vat+=lineVat;await c.query('INSERT INTO order_lines(tenant_id,order_id,product_id,product_name,quantity,unit_net,vat_rate,line_net,line_vat,line_gross) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[tenantId,order.rows[0].id,p.id,p.name,item.quantity,p.price_net,p.vat_rate,lineNet.toFixed(2),lineVat.toFixed(2),(lineNet+lineVat).toFixed(2)])}await c.query("UPDATE orders SET net_total=$3,vat_total=$4,gross_total=$5,status='sent' WHERE tenant_id=$1 AND id=$2",[tenantId,order.rows[0].id,net.toFixed(2),vat.toFixed(2),(net+vat).toFixed(2)]);return{orderNumber:order.rows[0].orderNumber,tableLabel:label,total:(net+vat).toFixed(2),status:'received'}});
  }
  @Post('setup') async setup(@Body() b: { tenantName: string; slug: string; fullName: string; email: string; password: string }) {
    if (!b?.tenantName || !b.slug || !b.fullName || !b.email || !b.password || b.password.length < 12) throw new BadRequestException('Datos completos y contraseña de 12 caracteres como mínimo');
    // Setup usa una transacción fuera del contexto tenant solo para bootstrap inicial.
    return this.db.bootstrap(async client => {
      await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const count = await client.query('SELECT count(*)::int n FROM users');
      if (count.rows[0].n > 0) throw new BadRequestException('Setup ya completado');
      const t = await client.query('INSERT INTO tenants(slug,name) VALUES($1,$2) RETURNING id', [b.slug.toLowerCase(), b.tenantName]);
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [t.rows[0].id]);
      const u = await client.query('INSERT INTO users(email,password_hash,full_name) VALUES(lower($1),$2,$3) RETURNING id', [b.email, await argon2.hash(b.password), b.fullName]);
      await client.query("INSERT INTO tenant_users(tenant_id,user_id,role) VALUES($1,$2,'admin')", [t.rows[0].id, u.rows[0].id]);
      return { tenant: b.slug.toLowerCase(), user: b.email };
    });
  }
  @Get('menu') async menu(@Req() req: AuthRequest) {
    try { return await this.db.tenant(req, async c => (await c.query(`SELECT p.id,p.name,p.description,p.category_id "categoryId",p.price_net "priceNet",p.vat_rate "vatRate",c.name "categoryName"
      FROM products p LEFT JOIN categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id WHERE p.active ORDER BY c.sort_order,p.name`)).rows); }
    catch (e) { if ((e as Error).message === 'AUTH_REQUIRED') throw new UnauthorizedException(); throw e; }
  }
  @Post('products') async createProduct(@Req() req: AuthRequest, @Body() b: any) {
    if (!req.session?.app) throw new UnauthorizedException();
    if (!['admin','manager'].includes(req.session.app.role)) throw new ForbiddenException();
    if (!b?.name || !Number.isFinite(b.priceNet) || !Number.isFinite(b.vatRate)) throw new BadRequestException('Nombre, precio neto e IVA son obligatorios');
    return this.db.tenant(req, async c => {
      const result = await c.query(`INSERT INTO products(tenant_id,category_id,name,description,price_net,vat_rate)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,category_id "categoryId",price_net "priceNet",vat_rate "vatRate"`,
        [req.session.app!.tenantId,b.categoryId||null,b.name,b.description||null,b.priceNet,b.vatRate]); return result.rows[0];
    });
  }
}
