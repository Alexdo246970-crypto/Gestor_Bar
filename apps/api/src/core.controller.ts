import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as argon2 from 'argon2';
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
      const result = await c.query(`INSERT INTO products(tenant_id,category_id,name,description,price_net,vat_rate,available_from,available_to)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,category_id "categoryId",price_net "priceNet",vat_rate "vatRate"`,
        [req.session.app!.tenantId,b.categoryId||null,b.name,b.description||null,b.priceNet,b.vatRate,b.availableFrom||null,b.availableTo||null]); return result.rows[0];
    });
  }
}
