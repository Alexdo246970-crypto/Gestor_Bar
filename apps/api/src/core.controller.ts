import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, HttpException, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { DbService, AuthRequest } from './db.service';

@ApiTags('catalog')
@Controller()
export class CoreController {
  constructor(private readonly db: DbService) {}
  private admin(req: AuthRequest) {
    const session = req.session?.app;
    if (!session) throw new UnauthorizedException();
    if (session.role !== 'admin') throw new ForbiddenException('Solo un administrador puede gestionar usuarios');
    return session;
  }
  private async audit(c: any, tenantId: string, actorId: string, event: string, targetId: string | null, details: object = {}) {
    await c.query('INSERT INTO audit_events(tenant_id,actor_id,event_type,target_id,details) VALUES($1,$2,$3,$4,$5::jsonb)',
      [tenantId, actorId, event, targetId, JSON.stringify(details)]);
  }
  @Get('staff') async staff(@Req() req: AuthRequest) {
    const s = this.admin(req);
    return this.db.tenant(req, async c => (await c.query(`SELECT u.id,u.email,u.full_name "fullName",tu.role,tu.active
      FROM tenant_users tu JOIN users u ON u.id=tu.user_id WHERE tu.tenant_id=$1 AND u.active ORDER BY tu.active DESC,u.full_name`, [s.tenantId])).rows);
  }
  @Post('staff') async addStaff(@Req() req: AuthRequest, @Body() b: { email: string; fullName: string; password: string; role: string }) {
    const s = this.admin(req);
    const roles = ['admin','owner','manager','waiter','temporary_waiter','cashier'];
    const email = String(b?.email || '').trim().toLowerCase(), fullName = String(b?.fullName || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(email) || !fullName || !b?.password || b.password.length < 12 || !roles.includes(b.role)) {
      throw new BadRequestException('Indica nombre, email válido, contraseña de 12 caracteres y perfil válido');
    }
    return this.db.tenant(req, async c => {
      const existing = await c.query('SELECT id,email,full_name "fullName" FROM users WHERE lower(email)=lower($1) FOR UPDATE', [email]);
      let user = existing.rows[0];
      if (!user) user = (await c.query(`INSERT INTO users(email,password_hash,full_name) VALUES($1,$2,$3)
        RETURNING id,email,full_name "fullName"`, [email, await argon2.hash(b.password), fullName])).rows[0];
      const link = await c.query('INSERT INTO tenant_users(tenant_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id', [s.tenantId,user.id,b.role]);
      if (!link.rowCount) throw new BadRequestException('Ese usuario ya pertenece a este local');
      await this.audit(c, s.tenantId, s.userId, 'staff.created', user.id, { role: b.role, email });
      return { ...user, role: b.role, active: true };
    });
  }
  @Patch('staff/:id') async updateStaff(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: { role?: string; active?: boolean }) {
    const s = this.admin(req);
    const roles = ['admin','owner','manager','waiter','temporary_waiter','cashier'];
    if ((b.role !== undefined && !roles.includes(b.role)) || (b.active !== undefined && typeof b.active !== 'boolean') || (!b.role && b.active === undefined)) {
      throw new BadRequestException('Indica un perfil o un estado válido');
    }
    if (id === s.userId && b.active === false) throw new BadRequestException('No puedes desactivar tu propio acceso');
    return this.db.tenant(req, async c => {
      const current = await c.query('SELECT role,active FROM tenant_users WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE', [s.tenantId,id]);
      if (!current.rows[0]) throw new BadRequestException('Usuario no encontrado');
      const nextRole = b.role ?? current.rows[0].role, nextActive = b.active ?? current.rows[0].active;
      if (current.rows[0].role === 'admin' && current.rows[0].active && (nextRole !== 'admin' || !nextActive)) {
        const admins = await c.query("SELECT user_id FROM tenant_users WHERE tenant_id=$1 AND role='admin' AND active FOR UPDATE", [s.tenantId]);
        if (Number(admins.rowCount) <= 1) throw new BadRequestException('El local debe conservar al menos un administrador activo');
      }
      await c.query('UPDATE tenant_users SET role=$3,active=$4 WHERE tenant_id=$1 AND user_id=$2', [s.tenantId,id,nextRole,nextActive]);
      if (!nextActive) await c.query("DELETE FROM sessions WHERE sess #>> '{app,tenantId}'=$1 AND sess #>> '{app,userId}'=$2", [s.tenantId,id]);
      await this.audit(c, s.tenantId, s.userId, 'staff.updated', id, { previousRole: current.rows[0].role, role: nextRole, active: nextActive });
      return { id, role: nextRole, active: nextActive };
    });
  }
  @Delete('staff/:id') async deactivateStaff(@Req() req: AuthRequest, @Param('id') id: string) {
    const s = this.admin(req);
    if (id === s.userId) throw new BadRequestException('No puedes desactivar tu propio acceso');
    return this.db.tenant(req, async c => {
      const member = await c.query('SELECT role,active FROM tenant_users WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE', [s.tenantId,id]);
      if (!member.rows[0] || !member.rows[0].active) throw new BadRequestException('Usuario activo no encontrado');
      if (member.rows[0].role === 'admin') {
        const admins = await c.query("SELECT user_id FROM tenant_users WHERE tenant_id=$1 AND role='admin' AND active FOR UPDATE", [s.tenantId]);
        if (Number(admins.rowCount) <= 1) throw new BadRequestException('El local debe conservar al menos un administrador activo');
      }
      await c.query('UPDATE tenant_users SET active=false WHERE tenant_id=$1 AND user_id=$2', [s.tenantId,id]);
      await c.query("DELETE FROM sessions WHERE sess #>> '{app,tenantId}'=$1 AND sess #>> '{app,userId}'=$2", [s.tenantId,id]);
      await this.audit(c, s.tenantId, s.userId, 'staff.deactivated', id, { role: member.rows[0].role });
      return { ok: true };
    });
  }
  @Get('activity') async activity(@Req() req: AuthRequest) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin','owner'].includes(s.role)) throw new ForbiddenException();
    return this.db.tenant(req, async c => (await c.query(`SELECT a.id,a.event_type "eventType",a.target_id "targetId",a.details,a.created_at "createdAt",u.full_name "actorName"
      FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE a.tenant_id=$1 ORDER BY a.created_at DESC LIMIT 100`, [s.tenantId])).rows);
  }
  @Get('tenant') async tenantInfo(@Req() req: AuthRequest) {
    const s=req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin','owner','manager'].includes(s.role)) throw new ForbiddenException();
    return this.db.tenant(req, async c => (await c.query('SELECT name,slug,timezone,currency FROM tenants WHERE id=$1', [s.tenantId])).rows[0]);
  }
  @Patch('tenant') async updateTenant(@Req() req: AuthRequest, @Body() b: { name?: string; timezone?: string }) {
    const s=req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin','owner'].includes(s.role)) throw new ForbiddenException();
    const name=b?.name===undefined?undefined:String(b.name).trim(), timezone=b?.timezone===undefined?undefined:String(b.timezone).trim();
    if ((name!==undefined&&!name) || (timezone!==undefined&&!timezone) || (name===undefined&&timezone===undefined)) throw new BadRequestException('Nombre y zona horaria deben tener un valor válido');
    if (timezone!==undefined) { try { new Intl.DateTimeFormat('es-ES',{timeZone:timezone}); } catch { throw new BadRequestException('Zona horaria no reconocida'); } }
    return this.db.tenant(req, async c => {
      const result=await c.query('UPDATE tenants SET name=coalesce($2,name),timezone=coalesce($3,timezone) WHERE id=$1 RETURNING name,slug,timezone,currency',[s.tenantId,name??null,timezone??null]);
      await this.audit(c,s.tenantId,s.userId,'tenant.updated',null,{name:name??null,timezone:timezone??null});
      return result.rows[0];
    });
  }

  @Get('public/menu/:token') async qrMenu(@Param('token') token:string) {
    const [tenantId,secret]=token.split('.');
    if(!tenantId||!secret)throw new BadRequestException('Código QR no válido');
    return this.db.bootstrap(async c=>{
      await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
      const table=await c.query('SELECT id,label FROM dining_tables WHERE tenant_id=$1 AND qr_token=$2 AND active',[tenantId,secret]);
      if(!table.rows[0])throw new BadRequestException('Código QR no válido');
      const settings=await c.query('SELECT max_order_lines "maxOrderLines" FROM tenant_qr_settings WHERE tenant_id=$1',[tenantId]);
      const products=await c.query(`SELECT p.id,p.name,p.description,p.price_net "priceNet",p.vat_rate "vatRate",c.name "categoryName" FROM products p LEFT JOIN categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id WHERE p.tenant_id=$1 AND p.active ORDER BY c.sort_order,p.name`,[tenantId]);
      return{tableId:table.rows[0].id,tableLabel:table.rows[0].label,maxOrderLines:settings.rows[0]?.maxOrderLines??20,products:products.rows};
    });
  }
  @Post('public/orders/:token') async qrOrder(@Param('token') token:string,@Body() b:{name:string;email?:string;customerSessionToken?:string;items:{productId:string;quantity:number}[]},@Headers('x-customer-session-token') sessionToken?:string) {
    if(!b?.name?.trim()||!Array.isArray(b.items)||!b.items.length||b.items.some(i=>!i.productId||!Number.isFinite(i.quantity)||i.quantity<=0||i.quantity>100))throw new BadRequestException('Indica tu nombre y productos con cantidades válidas');
    const [tenantId,secret]=token.split('.');
    if(!tenantId||!secret)throw new BadRequestException('Código QR no válido');
    return this.db.bootstrap(async c=>{
      await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
      const table=await c.query(`SELECT id,label,qr_last_order_at "lastOrderAt" FROM dining_tables
        WHERE tenant_id=$1 AND qr_token=$2 AND active FOR UPDATE`,[tenantId,secret]);
      if(!table.rows[0])throw new BadRequestException('Código QR no válido');
      const {id:tableId,label,lastOrderAt}=table.rows[0];
      const settings=(await c.query(`SELECT approval_required "approvalRequired",max_order_lines "maxOrderLines",
        cooldown_seconds "cooldownSeconds" FROM tenant_qr_settings WHERE tenant_id=$1`,[tenantId])).rows[0]
        ??{approvalRequired:false,maxOrderLines:20,cooldownSeconds:120};
      if(b.items.length>Number(settings.maxOrderLines))throw new BadRequestException(`El pedido no puede superar ${settings.maxOrderLines} líneas`);
      if(new Set(b.items.map(i=>i.productId)).size!==b.items.length)throw new BadRequestException('No repitas productos; ajusta su cantidad en una sola línea');
      if(Number(settings.cooldownSeconds)>0&&lastOrderAt&&Date.now()-new Date(lastOrderAt).getTime()<Number(settings.cooldownSeconds)*1000){
        throw new HttpException(`Espera ${settings.cooldownSeconds} segundos entre pedidos de esta mesa`, 429);
      }
      const customerToken=sessionToken||b.customerSessionToken;
      let customer:any=null;
      if(customerToken){
        customer=(await c.query(`SELECT cs.customer_id "customerId",cu.full_name "fullName",cu.email,cu.preferences
          FROM customer_sessions cs JOIN customers cu ON cu.tenant_id=cs.tenant_id AND cu.id=cs.customer_id
          WHERE cs.tenant_id=$1 AND cs.token_hash=$2 AND cs.expires_at>now() AND cs.revoked_at IS NULL`,
          [tenantId,createHash('sha256').update(customerToken).digest('hex')])).rows[0];
        if(!customer)throw new UnauthorizedException('La sesión de cliente ha caducado; inicia sesión de nuevo');
      }
      const status=settings.approvalRequired?'pending_approval':'sent';
      const order=await c.query(`INSERT INTO orders(tenant_id,opened_by,channel,table_id,table_label,customer_name,customer_email,customer_id,customer_preferences,status,qr_status_token)
        VALUES($1,NULL,'qr',$2,$3,$4,$5,$6,$7,$8,encode(gen_random_bytes(24),'hex'))
        RETURNING id,order_number "orderNumber",qr_status_token "statusToken"`,[tenantId,tableId,label,customer?.fullName||b.name.trim(),customer?.email||b.email?.trim()||null,customer?.customerId||null,customer?.preferences||null,status]);
      let net=0,vat=0;
      for(const item of b.items){
        const product=await c.query('SELECT id,name,price_net,vat_rate FROM products WHERE tenant_id=$1 AND id=$2 AND active',[tenantId,item.productId]);
        if(!product.rows[0])throw new BadRequestException('Uno de los productos ya no está disponible');
        const p=product.rows[0],lineNet=Number(p.price_net)*item.quantity,lineVat=lineNet*Number(p.vat_rate)/100;
        net+=lineNet;vat+=lineVat;
        await c.query('INSERT INTO order_lines(tenant_id,order_id,product_id,product_name,quantity,unit_net,vat_rate,line_net,line_vat,line_gross) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[tenantId,order.rows[0].id,p.id,p.name,item.quantity,p.price_net,p.vat_rate,lineNet.toFixed(2),lineVat.toFixed(2),(lineNet+lineVat).toFixed(2)]);
      }
      await c.query('UPDATE orders SET net_total=$3,vat_total=$4,gross_total=$5 WHERE tenant_id=$1 AND id=$2',[tenantId,order.rows[0].id,net.toFixed(2),vat.toFixed(2),(net+vat).toFixed(2)]);
      await c.query('UPDATE dining_tables SET qr_last_order_at=now() WHERE tenant_id=$1 AND id=$2',[tenantId,tableId]);
      return{orderNumber:order.rows[0].orderNumber,tableLabel:label,total:(net+vat).toFixed(2),status,statusToken:order.rows[0].statusToken};
    });
  }

  @Get('public/orders/:tenantId/:orderNumber/status/:statusToken') async qrOrderStatus(@Param('tenantId') tenantId:string,@Param('orderNumber') orderNumber:string,@Param('statusToken') statusToken:string) {
    return this.db.bootstrap(async c=>{
      await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
      const result=await c.query(`SELECT order_number "orderNumber",table_label "tableLabel",status
        FROM orders WHERE tenant_id=$1 AND order_number=$2 AND qr_status_token=$3 AND channel='qr'`,[tenantId,orderNumber,statusToken]);
      if(!result.rowCount)throw new BadRequestException('No se encuentra el pedido');
      return result.rows[0];
    });
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
      const u = await client.query('INSERT INTO users(email,password_hash,full_name,platform_admin) VALUES(lower($1),$2,$3,true) RETURNING id', [b.email, await argon2.hash(b.password), b.fullName]);
      await client.query("INSERT INTO tenant_users(tenant_id,user_id,role) VALUES($1,$2,'admin')", [t.rows[0].id, u.rows[0].id]);
      return { tenant: b.slug.toLowerCase(), user: b.email };
    });
  }
  @Get('menu') async menu(@Req() req: AuthRequest) {
    const role = req.session?.app?.role;
    if (!role) throw new UnauthorizedException();
    if (!['admin','manager','waiter','cashier'].includes(role)) throw new ForbiddenException('Permiso insuficiente');
    try { return await this.db.tenant(req, async c => (await c.query(`SELECT p.id,p.name,p.description,p.category_id "categoryId",p.price_net "priceNet",p.vat_rate "vatRate",c.name "categoryName"
      FROM products p LEFT JOIN categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id WHERE p.active AND (p.available_from IS NULL OR p.available_from<=current_date) AND (p.available_to IS NULL OR p.available_to>=current_date) ORDER BY c.sort_order,p.name`)).rows); }
    catch (e) { if ((e as Error).message === 'AUTH_REQUIRED') throw new UnauthorizedException(); throw e; }
  }
  @Post('products') async createProduct(@Req() req: AuthRequest, @Body() b: any) {
    if (!req.session?.app) throw new UnauthorizedException();
    if (!['admin','manager'].includes(req.session.app.role)) throw new ForbiddenException();
    if (!b?.name || !Number.isFinite(b.priceNet) || !Number.isFinite(b.vatRate)) throw new BadRequestException('Nombre, precio neto e IVA son obligatorios');
    return this.db.tenant(req, async c => {
      if (b.availableFrom && b.availableTo && b.availableFrom > b.availableTo) throw new BadRequestException('La fecha de fin debe ser posterior al inicio');
      const station=b.kitchenStation||'kitchen';if(!['kitchen','bar'].includes(station))throw new BadRequestException('Partida de cocina no válida');
      if(b.stockItemId){const item=await c.query('SELECT id FROM ingredients WHERE tenant_id=$1 AND id=$2 AND active',[req.session.app!.tenantId,b.stockItemId]);if(!item.rowCount)throw new BadRequestException('Artículo de stock no disponible');}
      const result = await c.query(`INSERT INTO products(tenant_id,category_id,name,description,price_net,vat_rate,available_from,available_to,kitchen_station,stock_item_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,name,category_id "categoryId",price_net "priceNet",vat_rate "vatRate",kitchen_station "kitchenStation",stock_item_id "stockItemId"`,
        [req.session.app!.tenantId,b.categoryId||null,b.name,b.description||null,b.priceNet,b.vatRate,b.availableFrom||null,b.availableTo||null,station,b.stockItemId||null]); return result.rows[0];
    });
  }
}
