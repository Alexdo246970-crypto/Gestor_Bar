import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

type RoomBody = { name?: string; widthCm?: number; heightCm?: number; sortOrder?: number };
const COLUMNS = `id,name,width_cm "widthCm",height_cm "heightCm",sort_order "sortOrder",active`;

@ApiTags('rooms')
@Controller('rooms')
export class RoomsController {
  constructor(private readonly db: DbService) {}

  private session(req: AuthRequest, write = false) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (write && !['admin', 'manager'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }
  private duplicate(e: unknown): never {
    if ((e as { code?: string }).code === '23505') throw new BadRequestException('Ya existe una sala con ese nombre');
    throw e;
  }
  private validate(b: RoomBody, partial: boolean) {
    if (!b) throw new BadRequestException('Datos de sala requeridos');
    if (!partial && !b.name?.trim()) throw new BadRequestException('El nombre de la sala es obligatorio');
    if (b.name !== undefined && !String(b.name).trim()) throw new BadRequestException('El nombre de la sala no puede estar vacío');
    for (const [key, min, max] of [['widthCm', 100, 10000], ['heightCm', 100, 10000]] as const) {
      const value = b[key];
      if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) throw new BadRequestException(`${key} no válido`);
    }
    if (b.sortOrder !== undefined && !Number.isInteger(b.sortOrder)) throw new BadRequestException('Orden no válido');
  }

  @Get() async list(@Req() req: AuthRequest) {
    const s = this.session(req);
    return this.db.tenant(req, async c => (await c.query(`SELECT ${COLUMNS},
      (SELECT count(*)::int FROM dining_tables t WHERE t.tenant_id=r.tenant_id AND t.room_id=r.id AND t.active) "tableCount",
      (SELECT count(*)::int FROM dining_tables t WHERE t.tenant_id=r.tenant_id AND t.room_id=r.id AND t.active AND EXISTS
        (SELECT 1 FROM orders o WHERE o.tenant_id=t.tenant_id AND o.table_id=t.id AND o.status IN ('open','pending_approval','sent'))) "busyCount"
      FROM rooms r WHERE r.tenant_id=$1 AND r.active ORDER BY r.sort_order,r.name`, [s.tenantId])).rows);
  }

  @Post() async create(@Req() req: AuthRequest, @Body() b: RoomBody) {
    const s = this.session(req, true);
    this.validate(b, false);
    return this.db.tenant(req, async c => {
      try {
        return (await c.query(`INSERT INTO rooms(tenant_id,name,width_cm,height_cm,sort_order)
          VALUES($1,$2,$3,$4,$5) RETURNING ${COLUMNS}`,
          [s.tenantId, b.name!.trim(), b.widthCm ?? 800, b.heightCm ?? 500, b.sortOrder ?? 0])).rows[0];
      } catch (e) { this.duplicate(e); }
    });
  }

  @Patch(':id') async update(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: RoomBody) {
    const s = this.session(req, true);
    this.validate(b, true);
    return this.db.tenant(req, async c => {
      try {
        const r = await c.query(`UPDATE rooms SET name=coalesce($3,name),width_cm=coalesce($4,width_cm),
            height_cm=coalesce($5,height_cm),sort_order=coalesce($6,sort_order)
          WHERE tenant_id=$1 AND id=$2 AND active RETURNING ${COLUMNS}`,
          [s.tenantId, id, b.name?.trim() ?? null, b.widthCm ?? null, b.heightCm ?? null, b.sortOrder ?? null]);
        if (!r.rowCount) throw new BadRequestException('Sala no encontrada');
        if (b.name) await c.query(`UPDATE dining_tables SET zone=$3 WHERE tenant_id=$1 AND room_id=$2`, [s.tenantId, id, r.rows[0].name]);
        return r.rows[0];
      } catch (e) { this.duplicate(e); }
    });
  }

  /** Archivar conserva sala, mesas e histórico; solo la oculta del servicio. */
  @Delete(':id') async archive(@Req() req: AuthRequest, @Param('id') id: string, @Query('force') force?: string) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const busy = await c.query(`SELECT 1 FROM dining_tables t WHERE t.tenant_id=$1 AND t.room_id=$2 AND t.active AND EXISTS
        (SELECT 1 FROM orders o WHERE o.tenant_id=t.tenant_id AND o.table_id=t.id AND o.status IN ('open','pending_approval','sent'))`, [s.tenantId, id]);
      const confirmed = String(force).toLowerCase() === 'true' || req.body?.force === true || String(req.body?.force).toLowerCase() === 'true';
      if (busy.rowCount && !confirmed) throw new BadRequestException('La sala tiene comandas abiertas; confirma para archivarla');
      const r = await c.query('UPDATE rooms SET active=false WHERE tenant_id=$1 AND id=$2 AND active', [s.tenantId, id]);
      if (!r.rowCount) throw new BadRequestException('Sala no encontrada');
      return { ok: true, archivedWithOpenOrders: (busy.rowCount ?? 0) > 0 };
    });
  }
}
