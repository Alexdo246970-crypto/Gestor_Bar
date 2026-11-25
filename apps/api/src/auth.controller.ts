import { Body, Controller, Get, Param, Post, Req, UnauthorizedException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as argon2 from 'argon2';
import { DbService, AuthRequest } from './db.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly db: DbService) {}
  private async startSession(req: AuthRequest, app: NonNullable<AuthRequest['session']['app']>) {
    await new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.app = app;
    await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
  }
  @Post('login') async login(@Body() body: { tenant: string; email: string; password: string }, @Req() req: AuthRequest) {
    if (!body?.tenant || !body.email || !body.password) throw new BadRequestException('tenant, email y password son obligatorios');
    const row = await this.db.bootstrap(async client => {
      const tenant = await client.query('SELECT id FROM tenants WHERE slug=$1 AND active', [body.tenant]);
      if (!tenant.rows[0]) return null;
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
      const found = await client.query(`SELECT u.id user_id,u.email,u.full_name,t.id tenant_id,t.name tenant_name,tu.role,u.password_hash,u.expires_at
        FROM tenants t JOIN tenant_users tu ON tu.tenant_id=t.id JOIN users u ON u.id=tu.user_id
        WHERE t.id=$1 AND lower(u.email)=lower($2) AND t.active AND u.active AND tu.active AND (u.expires_at IS NULL OR u.expires_at>now())`, [tenant.rows[0].id, body.email]);
      return found.rows[0] || null;
    });
    if (!row || !(await argon2.verify(row.password_hash, body.password))) throw new UnauthorizedException('Credenciales incorrectas');
    await new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.app = { userId: row.user_id, tenantId: row.tenant_id, tenantName: row.tenant_name, role: row.role };
    if(row.expires_at) req.session.cookie.maxAge=Math.max(0,Math.min(12*60*60*1000,new Date(row.expires_at).getTime()-Date.now()));
    await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    return { user: { id: row.user_id, email: row.email, fullName: row.full_name, tenantId: row.tenant_id, tenantName: row.tenant_name, role: row.role } };
  }
  @Post('platform/login') async platformLogin(@Body() body: { email: string; password: string }, @Req() req: AuthRequest) {
    if (!body?.email || !body.password) throw new BadRequestException('Email y contraseña son obligatorios');
    const row = await this.db.bootstrap(async c => (await c.query(`SELECT id,email,full_name,password_hash FROM users
      WHERE lower(email)=lower($1) AND active AND platform_admin`, [body.email.trim()])).rows[0]);
    if (!row || !(await argon2.verify(row.password_hash, body.password))) throw new UnauthorizedException('Credenciales incorrectas');
    await this.startSession(req, { userId: row.id, tenantId: '', tenantName: 'Panel de control', role: 'admin', platformAdmin: true });
    return { user: { id: row.id, email: row.email, fullName: row.full_name, tenantId: '', tenantName: 'Panel de control', role: 'admin', platformAdmin: true } };
  }
  private platformAdmin(req: AuthRequest) {
    const app = req.session?.app;
    if (!app) throw new UnauthorizedException();
    if (!app.platformAdmin) throw new ForbiddenException('Solo un administrador de plataforma puede acceder a los restaurantes');
    return app;
  }
  @Get('platform/tenants') async platformTenants(@Req() req: AuthRequest) {
    this.platformAdmin(req);
    return this.db.bootstrap(async c => (await c.query(`SELECT id,slug,name,timezone,currency,created_at "createdAt"
      FROM tenants WHERE active ORDER BY name,slug`)).rows);
  }
  @Post('platform/tenants/:tenantId') async selectPlatformTenant(@Req() req: AuthRequest, @Param('tenantId') tenantId: string) {
    const app = this.platformAdmin(req);
    const { tenant, user } = await this.db.bootstrap(async c => {
      const tenant = (await c.query('SELECT id,slug,name FROM tenants WHERE id=$1 AND active', [tenantId])).rows[0];
      const user = (await c.query('SELECT email,full_name FROM users WHERE id=$1 AND active AND platform_admin', [app.userId])).rows[0];
      return { tenant, user };
    });
    if (!tenant) throw new NotFoundException('Restaurante no encontrado');
    if (!user) throw new UnauthorizedException();
    req.session.app = { ...app, tenantId: tenant.id, tenantName: tenant.name, role: 'admin' };
    await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    return { user: { id: app.userId, email: user.email, fullName: user.full_name, tenantId: tenant.id, tenantName: tenant.name, role: 'admin', platformAdmin: true } };
  }
  @Post('platform/panel') async returnToPlatformPanel(@Req() req: AuthRequest) {
    const app = this.platformAdmin(req);
    req.session.app = { ...app, tenantId: '', tenantName: 'Panel de control', role: 'admin' };
    await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    return { ok: true };
  }
  @Post('logout') async logout(@Req() req: AuthRequest) { await new Promise<void>(resolve => req.session.destroy(() => resolve())); return { ok: true }; }
  @Get('me') async me(@Req() req: AuthRequest) {
    if (!req.session?.app) throw new UnauthorizedException();
    if (req.session.app.platformAdmin) {
      return this.db.bootstrap(async c => {
        const r = await c.query(`SELECT email,full_name "fullName" FROM users WHERE id=$1 AND active AND platform_admin`, [req.session.app!.userId]);
        if (!r.rows[0]) throw new UnauthorizedException();
        const tenantId = req.session.app!.tenantId;
        if (!tenantId) return { id: req.session.app!.userId, ...r.rows[0], tenantId: '', tenantName: 'Panel de control', role: 'admin', platformAdmin: true };
        const tenant = await c.query('SELECT name FROM tenants WHERE id=$1 AND active', [tenantId]);
        if (!tenant.rows[0]) throw new UnauthorizedException();
        return { id: req.session.app!.userId, ...r.rows[0], tenantId, tenantName: tenant.rows[0].name, role: 'admin', platformAdmin: true };
      });
    }
    return this.db.tenant(req, async c => {
      const r = await c.query(`SELECT u.id,u.email,u.full_name "fullName",t.id "tenantId",t.name "tenantName",tu.role
        FROM users u JOIN tenant_users tu ON tu.user_id=u.id AND tu.tenant_id=$1
        JOIN tenants t ON t.id=tu.tenant_id WHERE u.id=$2 AND u.active AND tu.active`,
        [req.session.app!.tenantId,req.session.app!.userId]);
      if (!r.rows[0]) throw new UnauthorizedException(); return r.rows[0];
    });
  }
}
