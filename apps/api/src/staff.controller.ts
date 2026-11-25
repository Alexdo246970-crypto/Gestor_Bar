import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

const ASSIGNABLE_ROLES = ['kitchen', 'waiter', 'cashier'];

@ApiTags('staff')
@Controller('staff')
export class StaffController {
  constructor(private readonly db: DbService) {}

  private manager(req: AuthRequest) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin', 'manager'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }

  /** Equipo del local, con estado y si mantiene una sesión abierta. */
  @Get() async list(@Req() req: AuthRequest) {
    const s = this.manager(req);
    return this.db.tenant(req, async c => {
      const members = await c.query(`SELECT u.id,u.email,u.full_name "fullName",tu.role,tu.active,u.expires_at "expiresAt",u.created_at "createdAt"
        FROM tenant_users tu JOIN users u ON u.id=tu.user_id WHERE tu.tenant_id=$1 ORDER BY tu.role,u.full_name`, [s.tenantId]);
      const sessions = await this.db.query<{ userId: string }>(
        `SELECT DISTINCT sess->'app'->>'userId' "userId" FROM sessions WHERE sess->'app'->>'tenantId'=$1`, [s.tenantId]);
      const online = new Set(sessions.rows.map(row => row.userId));
      return members.rows.map(row => ({ ...row, hasSession: online.has(row.id) }));
    });
  }

  /** Alta de usuario interno (cocina o camarero) con contraseña temporal. */
  @Post() async create(@Req() req: AuthRequest, @Body() b: { fullName: string; email: string; password: string; role: string; expiresAt?: string | null }) {
    const s = this.manager(req);
    const role = String(b?.role || 'kitchen');
    if (!ASSIGNABLE_ROLES.includes(role)) throw new BadRequestException('Rol no asignable desde Equipo');
    if (!b?.fullName?.trim() || !b?.email?.trim() || !b?.password || b.password.length < 12) {
      throw new BadRequestException('Indica nombre, email y una contraseña temporal de 12 caracteres como mínimo');
    }
    let expiresAt: Date | null = null;
    if (b.expiresAt) {
      expiresAt = new Date(b.expiresAt);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) throw new BadRequestException('La fecha de caducidad debe ser futura');
      if (expiresAt.getTime() - Date.now() > 30 * 24 * 60 * 60 * 1000) throw new BadRequestException('La duración máxima de un perfil temporal es de 30 días');
    }
    if (role !== 'kitchen' && !expiresAt) throw new BadRequestException('Los perfiles temporales de sala o caja deben tener fecha de caducidad');
    return this.db.tenant(req, async c => {
      const existing = await c.query('SELECT id FROM users WHERE lower(email)=lower($1)', [b.email]);
      if (existing.rows[0]) throw new BadRequestException('Ese email ya está registrado');
      const argon2 = await import('argon2');
      const u = await c.query(`INSERT INTO users(email,password_hash,full_name,expires_at) VALUES(lower($1),$2,$3,$4)
        RETURNING id,email,full_name "fullName",expires_at "expiresAt",created_at "createdAt"`,
        [b.email.trim(), await argon2.hash(b.password), b.fullName.trim(), expiresAt]);
      await c.query('INSERT INTO tenant_users(tenant_id,user_id,role) VALUES($1,$2,$3)', [s.tenantId, u.rows[0].id, role]);
      await c.query(`INSERT INTO staff_account_audit(tenant_id,user_id,actor_id,action,details) VALUES($1,$2,$3,'created',$4)`, [s.tenantId,u.rows[0].id,s.userId,JSON.stringify({role,expiresAt})]);
      return { ...u.rows[0], role, active: true, hasSession: false };
    });
  }

  /** Compatibilidad con el flujo anterior de camareros temporales. */
  @Post('temporary-waiters') async createTemporary(@Req() req: AuthRequest, @Body() b: { fullName: string; email: string; password: string; expiresAt?: string | null }) {
    return this.create(req, { ...b, role: 'waiter' });
  }

  /** Activa o desactiva la pertenencia al local. Desactivar revoca las sesiones abiertas. */
  @Patch(':userId') async update(@Req() req: AuthRequest, @Param('userId') userId: string, @Body() b: { active: boolean }) {
    const s = this.manager(req);
    if (typeof b?.active !== 'boolean') throw new BadRequestException('Indica si el perfil queda activo');
    if (userId === s.userId) throw new BadRequestException('No puedes desactivar tu propio perfil');
    return this.db.tenant(req, async c => {
      const target = await c.query('SELECT role,active FROM tenant_users WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE', [s.tenantId, userId]);
      if (!target.rows[0]) throw new BadRequestException('Perfil no encontrado');
      if (!b.active && target.rows[0].role === 'admin') {
        const admins = await c.query("SELECT count(*)::int n FROM tenant_users WHERE tenant_id=$1 AND role='admin' AND active", [s.tenantId]);
        if (admins.rows[0].n <= 1) throw new BadRequestException('No se puede desactivar el último administrador del local');
      }
      const r = await c.query(`UPDATE tenant_users SET active=$3 WHERE tenant_id=$1 AND user_id=$2
        RETURNING user_id "userId",role,active`, [s.tenantId, userId, b.active]);
      if (!b.active) await this.revokeSessions(s.tenantId, userId);
      await c.query(`INSERT INTO staff_account_audit(tenant_id,user_id,actor_id,action,details) VALUES($1,$2,$3,$4,$5)`, [s.tenantId,userId,s.userId,b.active?'reactivated':'revoked',JSON.stringify({role:target.rows[0].role})]);
      return { ...r.rows[0], hasSession: false };
    });
  }

  /** Cierra todas las sesiones abiertas del usuario en este local. */
  @Post(':userId/revoke-sessions') async revoke(@Req() req: AuthRequest, @Param('userId') userId: string) {
    const s = this.manager(req);
    const member = await this.db.tenant(req, async c => (await c.query('SELECT 1 FROM tenant_users WHERE tenant_id=$1 AND user_id=$2', [s.tenantId, userId])).rowCount);
    if (!member) throw new BadRequestException('Perfil no encontrado');
    const removed = await this.revokeSessions(s.tenantId, userId);
    await this.db.tenant(req,c=>c.query(`INSERT INTO staff_account_audit(tenant_id,user_id,actor_id,action,details) VALUES($1,$2,$3,'sessions_revoked',$4)`,[s.tenantId,userId,s.userId,JSON.stringify({count:removed})]).then(()=>undefined));
    return { ok: true, revoked: removed };
  }

  private async revokeSessions(tenantId: string, userId: string) {
    const result = await this.db.query(`DELETE FROM sessions WHERE sess->'app'->>'tenantId'=$1 AND sess->'app'->>'userId'=$2`, [tenantId, userId]);
    return result.rowCount || 0;
  }
}
