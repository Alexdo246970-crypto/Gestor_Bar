import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

const SHAPES = ['square', 'round', 'bar'];
type TableBody = { label?: string; zone?: string; seats?: number; shape?: string; posX?: number; posY?: number };
const COLUMNS = `id,label,zone,seats,shape,pos_x "posX",pos_y "posY",span_x "spanX",span_y "spanY",jsonb_array_length(merged_from)::int "joinedCount"`;
type TableRow = { id: string; label: string; zone: string; seats: number; shape: string; pos_x: number; pos_y: number; span_x: number; span_y: number; merged_from: JoinSnapshot[] };
/** Estado de la mesa antes de una unión, para poder separarlas después. Los offsets son relativos a la esquina de la mesa unida. */
type JoinSnapshot = { joinedId: string; label: string; seats: number; shape: string; spanX: number; spanY: number; offX: number; offY: number; joinedOffX: number; joinedOffY: number };

/** "Mesa 1" + "Mesa 2" → "Mesa 1+2"; si no comparten prefijo, "Terraza 1 + Barra". */
export function joinedLabel(first: string, second: string) {
  const re = /^(.*?)\s*(\d+(?:\+\d+)*)$/, a = first.match(re), b = second.match(re);
  if (a && b && a[1].toLocaleLowerCase('es') === b[1].toLocaleLowerCase('es')) return `${a[1]}${a[1] ? ' ' : ''}${a[2]}+${b[2]}`;
  return `${first} + ${second}`;
}

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
      SELECT t.id,t.label,t.zone,t.seats,t.shape,t.pos_x "posX",t.pos_y "posY",t.span_x "spanX",t.span_y "spanY",jsonb_array_length(t.merged_from)::int "joinedCount",
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
          RETURNING ${COLUMNS}`,
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
          WHERE tenant_id=$1 AND id=$2 AND active RETURNING ${COLUMNS}`,
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

  /** Une dos mesas contiguas y alineadas en una sola mesa rectangular. La comanda abierta (si hay una) pasa a la mesa unida. */
  @Post(':id/join') async join(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: { withId?: string }) {
    const s = this.session(req, ['admin', 'manager']);
    if (!b?.withId || b.withId === id) throw new BadRequestException('Elige otra mesa para unir');
    return this.db.tenant(req, async c => {
      const rows: TableRow[] = (await c.query(`SELECT id,label,zone,seats,shape,pos_x,pos_y,span_x,span_y,merged_from FROM dining_tables
        WHERE tenant_id=$1 AND id = ANY($2::uuid[]) AND active FOR UPDATE`, [s.tenantId, [id, b.withId]])).rows;
      const a = rows.find(r => r.id === id), o = rows.find(r => r.id === b.withId);
      if (!a || !o) throw new BadRequestException('Mesa no encontrada');
      if (a.zone !== o.zone) throw new BadRequestException('Solo se pueden unir mesas de la misma zona');
      const horizontal = a.pos_y === o.pos_y && a.span_y === o.span_y && (a.pos_x + a.span_x === o.pos_x || o.pos_x + o.span_x === a.pos_x);
      const vertical = a.pos_x === o.pos_x && a.span_x === o.span_x && (a.pos_y + a.span_y === o.pos_y || o.pos_y + o.span_y === a.pos_y);
      if (!horizontal && !vertical) throw new BadRequestException('Las mesas deben estar juntas y alineadas para formar una mesa rectangular');
      const orders = (await c.query("SELECT id FROM orders WHERE tenant_id=$1 AND table_id = ANY($2::uuid[]) AND status IN ('open','sent') FOR UPDATE", [s.tenantId, [a.id, o.id]])).rows;
      if (orders.length > 1) throw new BadRequestException('Las dos mesas tienen comanda abierta; cobra una antes de unirlas');

      const ux = Math.min(a.pos_x, o.pos_x), uy = Math.min(a.pos_y, o.pos_y);
      const [first, second] = a.pos_x + a.pos_y <= o.pos_x + o.pos_y ? [a, o] : [o, a];
      const label = joinedLabel(first.label, second.label);
      const snapshot: JoinSnapshot = { joinedId: o.id, label: a.label, seats: a.seats, shape: a.shape, spanX: a.span_x, spanY: a.span_y,
        offX: a.pos_x - ux, offY: a.pos_y - uy, joinedOffX: o.pos_x - ux, joinedOffY: o.pos_y - uy };
      await c.query('UPDATE dining_tables SET active=false WHERE tenant_id=$1 AND id=$2', [s.tenantId, o.id]);
      try {
        const r = await c.query(`UPDATE dining_tables SET label=$3,seats=$4,shape='rect',pos_x=$5,pos_y=$6,span_x=$7,span_y=$8,merged_from=merged_from || $9::jsonb
          WHERE tenant_id=$1 AND id=$2 RETURNING ${COLUMNS}`,
          [s.tenantId, a.id, label, a.seats + o.seats, ux, uy, horizontal ? a.span_x + o.span_x : a.span_x, vertical ? a.span_y + o.span_y : a.span_y, JSON.stringify([snapshot])]);
        await c.query("UPDATE orders SET table_id=$2,table_label=$4 WHERE tenant_id=$1 AND table_id = ANY($3::uuid[]) AND status IN ('open','sent')", [s.tenantId, a.id, [a.id, o.id], label]);
        return r.rows[0];
      } catch (e) { this.duplicate(e); }
    });
  }

  /** Deshace la última unión: la mesa recupera su forma y la otra vuelve al plano a su lado. La comanda se queda en esta mesa. */
  @Post(':id/split') async split(@Req() req: AuthRequest, @Param('id') id: string) {
    const s = this.session(req, ['admin', 'manager']);
    return this.db.tenant(req, async c => {
      const t: TableRow | undefined = (await c.query('SELECT id,zone,pos_x,pos_y,merged_from FROM dining_tables WHERE tenant_id=$1 AND id=$2 AND active FOR UPDATE', [s.tenantId, id])).rows[0];
      if (!t) throw new BadRequestException('Mesa no encontrada');
      const last = t.merged_from[t.merged_from.length - 1];
      if (!last) throw new BadRequestException('Esta mesa no está unida a otra');
      try {
        const r = await c.query(`UPDATE dining_tables SET label=$3,seats=$4,shape=$5,span_x=$6,span_y=$7,pos_x=$8,pos_y=$9,merged_from=merged_from - (jsonb_array_length(merged_from)-1)
          WHERE tenant_id=$1 AND id=$2 RETURNING ${COLUMNS}`,
          [s.tenantId, id, last.label, last.seats, last.shape, last.spanX, last.spanY, t.pos_x + last.offX, t.pos_y + last.offY]);
        await c.query('UPDATE dining_tables SET active=true,zone=$3,pos_x=$4,pos_y=$5 WHERE tenant_id=$1 AND id=$2 AND NOT active',
          [s.tenantId, last.joinedId, t.zone, t.pos_x + last.joinedOffX, t.pos_y + last.joinedOffY]);
        await c.query("UPDATE orders SET table_label=$3 WHERE tenant_id=$1 AND table_id=$2 AND status IN ('open','sent')", [s.tenantId, id, last.label]);
        return r.rows[0];
      } catch (e) { this.duplicate(e); }
    });
  }
}
