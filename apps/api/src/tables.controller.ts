import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

const SHAPES = ['square', 'round', 'bar'];
type TableBody = { label?: string; zone?: string; seats?: number; shape?: string; posX?: number; posY?: number };

@ApiTags('tables')
@Controller('tables')
export class TablesController {
  constructor(private readonly db: DbService) {}
  private session(req: AuthRequest, roles = ['admin', 'manager', 'waiter', 'cashier']) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!roles.includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }
  private validate(b: TableBody, partial: boolean) {
    if (!b) throw new BadRequestException('Datos de mesa requeridos');
    if (!partial && !b.label?.trim()) throw new BadRequestException('El nombre de la mesa es obligatorio');
    if (b.label !== undefined && !String(b.label).trim()) throw new BadRequestException('El nombre de la mesa no puede estar vacío');
    if (b.seats !== undefined && (!Number.isInteger(b.seats) || b.seats <= 0)) throw new BadRequestException('Número de comensales no válido');
    if (b.shape !== undefined && !SHAPES.includes(b.shape)) throw new BadRequestException('Forma de mesa no válida');
    for (const v of [b.posX, b.posY]) if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new BadRequestException('Posición no válida');
  }
  private duplicate(e: unknown): never {
    if ((e as { code?: string }).code === '23505') throw new BadRequestException('Ya existe una mesa con ese nombre');
    throw e;
  }

  /** Mesas activas con el estado de su comanda abierta (si la hay). */
  @Get() async list(@Req() req: AuthRequest) {
    const s = this.session(req);
    return this.db.tenant(req, async c => (await c.query(`
      SELECT t.id,t.label,t.zone,t.seats,t.shape,t.pos_x "posX",t.pos_y "posY",
        CASE WHEN o.id IS NULL THEN NULL ELSE json_build_object('id',o.id,'orderNumber',o.order_number,'status',o.status,
          'openedAt',o.opened_at,'grossTotal',o.gross_total,
          'paidTotal',(SELECT coalesce(sum(p.amount),0) FROM payments p WHERE p.tenant_id=o.tenant_id AND p.order_id=o.id),
          'lineCount',(SELECT count(*)::int FROM order_lines l WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id)) END "activeOrder"
      FROM dining_tables t
      LEFT JOIN orders o ON o.tenant_id=t.tenant_id AND o.table_id=t.id AND o.status IN ('open','sent')
      WHERE t.tenant_id=$1 AND t.active ORDER BY t.zone,t.pos_y,t.pos_x,t.label`, [s.tenantId])).rows);
  }

  @Post() async create(@Req() req: AuthRequest, @Body() b: TableBody) {
    const s = this.session(req, ['admin', 'manager']);
    this.validate(b, false);
    return this.db.tenant(req, async c => {
      try {
        return (await c.query(`INSERT INTO dining_tables(tenant_id,label,zone,seats,shape,pos_x,pos_y) VALUES($1,$2,$3,$4,$5,$6,$7)
          RETURNING id,label,zone,seats,shape,pos_x "posX",pos_y "posY"`,
          [s.tenantId, b.label!.trim(), b.zone?.trim() || 'Salón', b.seats ?? 4, b.shape ?? 'square', b.posX ?? 0, b.posY ?? 0])).rows[0];
      } catch (e) { this.duplicate(e); }
    });
  }

  @Patch(':id') async update(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: TableBody) {
    const s = this.session(req, ['admin', 'manager']);
    this.validate(b, true);
    return this.db.tenant(req, async c => {
      try {
        const r = await c.query(`UPDATE dining_tables SET label=coalesce($3,label),zone=coalesce($4,zone),seats=coalesce($5,seats),
            shape=coalesce($6,shape),pos_x=coalesce($7,pos_x),pos_y=coalesce($8,pos_y)
          WHERE tenant_id=$1 AND id=$2 AND active RETURNING id,label,zone,seats,shape,pos_x "posX",pos_y "posY"`,
          [s.tenantId, id, b.label?.trim() ?? null, b.zone?.trim() || null, b.seats ?? null, b.shape ?? null, b.posX ?? null, b.posY ?? null]);
        if (!r.rowCount) throw new BadRequestException('Mesa no encontrada');
        // Mantener el nombre visible de la comanda abierta sincronizado con la mesa.
        if (b.label) await c.query("UPDATE orders SET table_label=$3 WHERE tenant_id=$1 AND table_id=$2 AND status IN ('open','sent')", [s.tenantId, id, r.rows[0].label]);
        return r.rows[0];
      } catch (e) { this.duplicate(e); }
    });
  }

  @Delete(':id') async remove(@Req() req: AuthRequest, @Param('id') id: string) {
    const s = this.session(req, ['admin', 'manager']);
    return this.db.tenant(req, async c => {
      const busy = await c.query("SELECT 1 FROM orders WHERE tenant_id=$1 AND table_id=$2 AND status IN ('open','sent')", [s.tenantId, id]);
      if (busy.rowCount) throw new BadRequestException('La mesa tiene una comanda abierta; cóbrala antes de eliminarla');
      const r = await c.query('UPDATE dining_tables SET active=false WHERE tenant_id=$1 AND id=$2 AND active', [s.tenantId, id]);
      if (!r.rowCount) throw new BadRequestException('Mesa no encontrada');
      return { ok: true };
    });
  }
}
