import { Body, Controller, Get, Post, Req, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as argon2 from 'argon2';
import { DbService, AuthRequest } from './db.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly db: DbService) {}
  @Post('login') async login(@Body() body: { tenant: string; email: string; password: string }, @Req() req: AuthRequest) {
    if (!body?.tenant || !body.email || !body.password) throw new BadRequestException('tenant, email y password son obligatorios');
    const row = await this.db.bootstrap(async client => {
      const tenant = await client.query('SELECT id FROM tenants WHERE slug=$1 AND active', [body.tenant]);
      if (!tenant.rows[0]) return null;
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
      const found = await client.query(`SELECT u.id user_id,u.email,u.full_name,t.id tenant_id,t.name tenant_name,tu.role,u.password_hash
        FROM tenants t JOIN tenant_users tu ON tu.tenant_id=t.id JOIN users u ON u.id=tu.user_id
        WHERE t.id=$1 AND lower(u.email)=lower($2) AND t.active AND u.active AND tu.active`, [tenant.rows[0].id, body.email]);
      return found.rows[0] || null;
    });
    if (!row || !(await argon2.verify(row.password_hash, body.password))) throw new UnauthorizedException('Credenciales incorrectas');
    await new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.app = { userId: row.user_id, tenantId: row.tenant_id, tenantName: row.tenant_name, role: row.role };
    await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    return { user: { id: row.user_id, email: row.email, fullName: row.full_name, tenantId: row.tenant_id, tenantName: row.tenant_name, role: row.role } };
  }
  @Post('logout') async logout(@Req() req: AuthRequest) { await new Promise<void>(resolve => req.session.destroy(() => resolve())); return { ok: true }; }
  @Get('me') async me(@Req() req: AuthRequest) {
    if (!req.session?.app) throw new UnauthorizedException();
    return this.db.tenant(req, async c => {
      const r = await c.query(`SELECT u.id,u.email,u.full_name "fullName",t.id "tenantId",t.name "tenantName",tu.role
        FROM users u JOIN tenant_users tu ON tu.user_id=u.id AND tu.tenant_id=$1
        JOIN tenants t ON t.id=tu.tenant_id WHERE u.id=$2 AND u.active AND tu.active`,
        [req.session.app!.tenantId,req.session.app!.userId]);
      if (!r.rows[0]) throw new UnauthorizedException(); return r.rows[0];
    });
  }
}
