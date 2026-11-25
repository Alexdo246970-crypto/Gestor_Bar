import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, MessageEvent, Param, Patch, Post, Req, Sse, UnauthorizedException } from '@nestjs/common';
import { interval, map, Observable } from 'rxjs';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

const SHAPES = ['square', 'round', 'bar', 'rect'];
const SIDES = ['long1', 'long2', 'short1', 'short2'];
type Side = typeof SIDES[number];
const ROUND: [number, number][] = [[70, 3], [90, 4], [120, 8], [150, 10]];
const SQUARE: [number, number][] = [[70, 2], [80, 4], [90, 4], [100, 6], [120, 8]];
type TableBody = {
  label?: string; zone?: string; seats?: number; shape?: string; posX?: number; posY?: number;
  diameterCm?: number; widthCm?: number; heightCm?: number; sidesUsed?: Side[];
};
/** Estado de la mesa antes de una unión, para poder separarla después. */
export type JoinSnapshot = {
  joinedId: string; label: string; seats: number; shape: string; spanX: number; spanY: number;
  offX: number; offY: number; joinedOffX: number; joinedOffY: number;
};
type TableRow = {
  id: string; label: string; zone: string; seats: number; shape: string; posX: number; posY: number;
  diameterCm: number | null; widthCm: number | null; heightCm: number | null; sidesUsed: Side[];
  seatsRecommended: number | null; spanX: number; spanY: number; mergedFrom: JoinSnapshot[];
};
const COLUMNS = `id,label,zone,seats,shape,pos_x "posX",pos_y "posY",(tenant_id::text||'.'||qr_token) "qrToken",
  diameter_cm "diameterCm",width_cm "widthCm",height_cm "heightCm",sides_used "sidesUsed",
  seats_recommended "seatsRecommended",span_x "spanX",span_y "spanY",
  jsonb_array_length(merged_from)::int "joinedCount"`;
const WARNING = `(seats_recommended IS NOT NULL AND abs(seats-seats_recommended) > CASE WHEN shape='round' THEN 1 ELSE 2 END) "seatsWarning"`;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const closest = (table: [number, number][], value: number) =>
  table.reduce((best, item) => Math.abs(item[0] - value) < Math.abs(best[0] - value) ? item : best)[1];
const num = (value: unknown, fallback: number) => value === undefined || value === null || value === '' ? fallback : Number(value);

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
  private session(req: AuthRequest, roles = ['admin', 'owner', 'manager', 'waiter', 'temporary_waiter', 'cashier']) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!roles.includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }

  /** Redonda usa diámetro, cuadrada usa lado y rectangular usa ancho/alto y lados usados. */
  private measures(shape: string, b: TableBody, current?: TableRow) {
    let diameter: number | null = null, width: number | null = null, height: number | null = null;
    let sides: Side[] = [], recommended: number | null = null;
    if (shape === 'round') {
      diameter = num(b.diameterCm ?? current?.diameterCm, 90);
      if (!(diameter >= 50 && diameter <= 200) || Math.abs(diameter * 2 - Math.round(diameter * 2)) > 1e-9)
        throw new BadRequestException('Diámetro no válido (50-200 cm, pasos de 0,5 cm)');
      recommended = closest(ROUND, diameter);
    } else if (shape === 'square') {
      width = num(b.widthCm ?? current?.widthCm, 80);
      if (!Number.isInteger(width) || width < 50 || width > 150) throw new BadRequestException('Lado no válido (50-150 cm)');
      height = width;
      recommended = closest(SQUARE, width);
    } else if (shape === 'rect') {
      width = num(b.widthCm ?? current?.widthCm, 120);
      height = num(b.heightCm ?? current?.heightCm, 80);
      if (!Number.isInteger(width) || width < 80 || width > 240) throw new BadRequestException('Ancho no válido (80-240 cm)');
      if (!Number.isInteger(height) || height < 60 || height > 120) throw new BadRequestException('Alto no válido (60-120 cm)');
      sides = (b.sidesUsed ?? current?.sidesUsed ?? ['long1', 'long2']).filter(s => SIDES.includes(s));
      if (!sides.length) throw new BadRequestException('Marca al menos un lado de la mesa');
      const longs = sides.filter(s => s.startsWith('long')).length;
      recommended = clamp(Math.floor(width / 60) * longs + (sides.length - longs), 1, 20);
    }
    const seats = b.seats ?? current?.seats ?? recommended ?? 4;
    if (!Number.isInteger(seats) || seats < 1 || seats > 20) throw new BadRequestException('Número de comensales no válido (1-20)');
    return { diameter, width, height, sides, recommended, seats };
  }

  private validate(b: TableBody, partial: boolean) {
    if (!b) throw new BadRequestException('Datos de mesa requeridos');
    if (!partial && !b.label?.trim()) throw new BadRequestException('El nombre de la mesa es obligatorio');
    if (b.label !== undefined && !String(b.label).trim()) throw new BadRequestException('El nombre de la mesa no puede estar vacío');
    if (b.shape !== undefined && !SHAPES.includes(b.shape)) throw new BadRequestException('Forma de mesa no válida');
    for (const v of [b.posX, b.posY]) if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new BadRequestException('Posición no válida');
  }
  private duplicate(e: unknown): never {
    if ((e as { code?: string }).code === '23505') throw new BadRequestException('Ya existe una mesa con ese nombre');
    throw e;
  }

  /** Eventos de cambio del mapa: el cliente recarga el estado al recibirlos. */
  @Sse('events') events(@Req() req: AuthRequest): Observable<MessageEvent> {
    this.session(req);
    return interval(5000).pipe(map(() => ({ data: { type: 'tables-changed', at: new Date().toISOString() } } as MessageEvent)));
  }

  /** Mesas activas con sus medidas, tamaño de la unión y estado de su comanda. */
  @Get() async list(@Req() req: AuthRequest) {
    const s = this.session(req);
    return this.db.tenant(req, async c => (await c.query(`
      SELECT ${COLUMNS}, ${WARNING},
        CASE WHEN o.id IS NULL THEN NULL ELSE json_build_object('id',o.id,'orderNumber',o.order_number,'status',o.status,
          'openedAt',o.opened_at,'grossTotal',o.gross_total,
          'paidTotal',(SELECT coalesce(sum(p.amount),0) FROM payments p WHERE p.tenant_id=o.tenant_id AND p.order_id=o.id),
          'lineCount',(SELECT count(*)::int FROM order_lines l WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id)) END "activeOrder"
      FROM dining_tables t
      LEFT JOIN orders o ON o.tenant_id=t.tenant_id AND o.table_id=t.id AND o.status IN ('open','pending_approval','sent')
      WHERE t.tenant_id=$1 AND t.active ORDER BY t.zone,t.pos_y,t.pos_x,t.label`, [s.tenantId])).rows);
  }

  @Get('qr-settings') async qrSettings(@Req() req: AuthRequest) {
    const s = this.session(req, ['admin', 'manager']);
    return this.db.tenant(req, async c => {
      await c.query('INSERT INTO tenant_qr_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [s.tenantId]);
      return (await c.query(`SELECT approval_required "approvalRequired",max_order_lines "maxOrderLines",
        cooldown_seconds "cooldownSeconds" FROM tenant_qr_settings WHERE tenant_id=$1`, [s.tenantId])).rows[0];
    });
  }

  @Patch('qr-settings') async updateQrSettings(@Req() req: AuthRequest, @Body() b: { approvalRequired: boolean; maxOrderLines: number; cooldownSeconds: number }) {
    const s = this.session(req, ['admin', 'manager']);
    if (typeof b?.approvalRequired !== 'boolean' || !Number.isInteger(b.maxOrderLines) || b.maxOrderLines < 1 || b.maxOrderLines > 20 ||
        !Number.isInteger(b.cooldownSeconds) || b.cooldownSeconds < 0 || b.cooldownSeconds > 3600) {
      throw new BadRequestException('Revisa la aprobación, el máximo de líneas (1–20) y el límite (0–3600 segundos)');
    }
    return this.db.tenant(req, async c => (await c.query(`INSERT INTO tenant_qr_settings(tenant_id,approval_required,max_order_lines,cooldown_seconds)
      VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id) DO UPDATE SET approval_required=excluded.approval_required,
      max_order_lines=excluded.max_order_lines,cooldown_seconds=excluded.cooldown_seconds,updated_at=now()
      RETURNING approval_required "approvalRequired",max_order_lines "maxOrderLines",cooldown_seconds "cooldownSeconds"`,
      [s.tenantId,b.approvalRequired,b.maxOrderLines,b.cooldownSeconds])).rows[0]);
  }

  @Post(':id/qr-token') async rotateQrToken(@Req() req: AuthRequest, @Param('id') id: string) {
    const s = this.session(req, ['admin', 'manager']);
    return this.db.tenant(req, async c => {
      const table = await c.query(`UPDATE dining_tables SET qr_token=encode(gen_random_bytes(24),'hex')
        WHERE tenant_id=$1 AND id=$2 AND active RETURNING (tenant_id::text||'.'||qr_token) "qrToken",label`, [s.tenantId,id]);
      if (!table.rowCount) throw new BadRequestException('Mesa no encontrada');
      return table.rows[0];
    });
  }

  @Post() async create(@Req() req: AuthRequest, @Body() b: TableBody) {
    const s = this.session(req, ['admin', 'manager']);
    this.validate(b, false);
    const shape = b.shape ?? 'square';
    const m = this.measures(shape, b);
    return this.db.tenant(req, async c => {
      const zone = b.zone?.trim() || 'Salón';
      const room = (await c.query('SELECT id FROM rooms WHERE tenant_id=$1 AND lower(name)=lower($2)', [s.tenantId, zone])).rows[0];
      try {
        return (await c.query(`INSERT INTO dining_tables
          (tenant_id,label,zone,room_id,seats,shape,pos_x,pos_y,diameter_cm,width_cm,height_cm,sides_used,seats_recommended)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) RETURNING ${COLUMNS}, ${WARNING}`,
          [s.tenantId, b.label!.trim(), zone, room?.id ?? null, m.seats, shape, b.posX ?? 0, b.posY ?? 0,
            m.diameter, m.width, m.height, JSON.stringify(m.sides), m.recommended])).rows[0];
      } catch (e) { this.duplicate(e); }
    });
  }

  @Patch(':id') async update(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: TableBody) {
    const s = this.session(req, ['admin', 'manager']);
    this.validate(b, true);
    return this.db.tenant(req, async c => {
      const room = b.zone ? (await c.query('SELECT id FROM rooms WHERE tenant_id=$1 AND lower(name)=lower($2)', [s.tenantId, b.zone.trim()])).rows[0] : null;
      const current: TableRow | undefined = (await c.query(`SELECT ${COLUMNS} FROM dining_tables WHERE tenant_id=$1 AND id=$2 AND active`, [s.tenantId, id])).rows[0];
      if (!current) throw new BadRequestException('Mesa no encontrada');
      const shape = b.shape ?? current.shape;
      const m = this.measures(shape, b, current);
      try {
        const r = await c.query(`UPDATE dining_tables SET label=coalesce($3,label),zone=coalesce($4,zone),
            room_id=coalesce($14,room_id),seats=$5,shape=$6,
            pos_x=coalesce($7,pos_x),pos_y=coalesce($8,pos_y),diameter_cm=$9,width_cm=$10,height_cm=$11,
            sides_used=$12::jsonb,seats_recommended=$13
          WHERE tenant_id=$1 AND id=$2 AND active RETURNING ${COLUMNS}, ${WARNING}`,
          [s.tenantId, id, b.label?.trim() ?? null, b.zone?.trim() || null, m.seats, shape, b.posX ?? null, b.posY ?? null,
            m.diameter, m.width, m.height, JSON.stringify(m.sides), m.recommended, room?.id ?? null]);
        if (b.label) await c.query("UPDATE orders SET table_label=$3 WHERE tenant_id=$1 AND table_id=$2 AND status IN ('open','pending_approval','sent')", [s.tenantId, id, r.rows[0].label]);
        return r.rows[0];
      } catch (e) { this.duplicate(e); }
    });
  }

  @Delete(':id') async remove(@Req() req: AuthRequest, @Param('id') id: string) {
    const s = this.session(req, ['admin', 'manager']);
    return this.db.tenant(req, async c => {
      const busy = await c.query("SELECT 1 FROM orders WHERE tenant_id=$1 AND table_id=$2 AND status IN ('open','pending_approval','sent')", [s.tenantId, id]);
      if (busy.rowCount) throw new BadRequestException('La mesa tiene una comanda abierta; cóbrala antes de eliminarla');
      const r = await c.query('UPDATE dining_tables SET active=false WHERE tenant_id=$1 AND id=$2 AND active', [s.tenantId, id]);
      if (!r.rowCount) throw new BadRequestException('Mesa no encontrada');
      return { ok: true };
    });
  }

  /** Une dos mesas contiguas y alineadas; la comanda abierta pasa a la mesa unida. */
  @Post(':id/join') async join(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: { withId?: string }) {
    const s = this.session(req, ['admin', 'manager']);
    if (!b?.withId || b.withId === id) throw new BadRequestException('Elige otra mesa para unir');
    return this.db.tenant(req, async c => {
      const rows: TableRow[] = (await c.query(`${SELECT_JOIN} FROM dining_tables
        WHERE tenant_id=$1 AND id = ANY($2::uuid[]) AND active FOR UPDATE`, [s.tenantId, [id, b.withId]])).rows;
      const a = rows.find(r => r.id === id), o = rows.find(r => r.id === b.withId);
      if (!a || !o) throw new BadRequestException('Mesa no encontrada');
      if (a.zone !== o.zone) throw new BadRequestException('Solo se pueden unir mesas de la misma zona');
      const horizontal = a.posY === o.posY && a.spanY === o.spanY && (a.posX + a.spanX === o.posX || o.posX + o.spanX === a.posX);
      const vertical = a.posX === o.posX && a.spanX === o.spanX && (a.posY + a.spanY === o.posY || o.posY + o.spanY === a.posY);
      if (!horizontal && !vertical) throw new BadRequestException('Las mesas deben estar juntas y alineadas para formar una mesa rectangular');
      const orders = (await c.query("SELECT id FROM orders WHERE tenant_id=$1 AND table_id = ANY($2::uuid[]) AND status IN ('open','pending_approval','sent') FOR UPDATE", [s.tenantId, [a.id, o.id]])).rows;
      if (orders.length > 1) throw new BadRequestException('Las dos mesas tienen comanda abierta; cobra una antes de unirlas');

      const ux = Math.min(a.posX, o.posX), uy = Math.min(a.posY, o.posY);
      const [first, second] = a.posX + a.posY <= o.posX + o.posY ? [a, o] : [o, a];
      const label = joinedLabel(first.label, second.label);
      const snapshot: JoinSnapshot = { joinedId: o.id, label: a.label, seats: a.seats, shape: a.shape, spanX: a.spanX, spanY: a.spanY,
        offX: a.posX - ux, offY: a.posY - uy, joinedOffX: o.posX - ux, joinedOffY: o.posY - uy };
      await c.query('UPDATE dining_tables SET active=false WHERE tenant_id=$1 AND id=$2', [s.tenantId, o.id]);
      try {
        const r = await c.query(`UPDATE dining_tables SET label=$3,seats=$4,shape='rect',pos_x=$5,pos_y=$6,span_x=$7,span_y=$8,merged_from=merged_from || $9::jsonb
          WHERE tenant_id=$1 AND id=$2 RETURNING ${COLUMNS}, ${WARNING}`,
          [s.tenantId, a.id, label, a.seats + o.seats, ux, uy, horizontal ? a.spanX + o.spanX : a.spanX, vertical ? a.spanY + o.spanY : a.spanY, JSON.stringify([snapshot])]);
        await c.query("UPDATE orders SET table_id=$2,table_label=$4 WHERE tenant_id=$1 AND table_id = ANY($3::uuid[]) AND status IN ('open','pending_approval','sent')", [s.tenantId, a.id, [a.id, o.id], label]);
        return r.rows[0];
      } catch (e) { this.duplicate(e); }
    });
  }

  /** Deshace la última unión: la mesa recupera su forma y la otra vuelve a su sitio. */
  @Post(':id/split') async split(@Req() req: AuthRequest, @Param('id') id: string) {
    const s = this.session(req, ['admin', 'manager']);
    return this.db.tenant(req, async c => {
      const t: TableRow | undefined = (await c.query(`${SELECT_JOIN} FROM dining_tables WHERE tenant_id=$1 AND id=$2 AND active FOR UPDATE`, [s.tenantId, id])).rows[0];
      if (!t) throw new BadRequestException('Mesa no encontrada');
      const last = t.mergedFrom[t.mergedFrom.length - 1];
      if (!last) throw new BadRequestException('Esta mesa no está unida a otra');
      try {
        const r = await c.query(`UPDATE dining_tables SET label=$3,seats=$4,shape=$5,span_x=$6,span_y=$7,pos_x=$8,pos_y=$9,merged_from=merged_from - (jsonb_array_length(merged_from)-1)
          WHERE tenant_id=$1 AND id=$2 RETURNING ${COLUMNS}, ${WARNING}`,
          [s.tenantId, id, last.label, last.seats, last.shape, last.spanX, last.spanY, t.posX + last.offX, t.posY + last.offY]);
        await c.query('UPDATE dining_tables SET active=true,zone=$3,pos_x=$4,pos_y=$5 WHERE tenant_id=$1 AND id=$2 AND NOT active',
          [s.tenantId, last.joinedId, t.zone, t.posX + last.joinedOffX, t.posY + last.joinedOffY]);
        await c.query("UPDATE orders SET table_label=$3 WHERE tenant_id=$1 AND table_id=$2 AND status IN ('open','pending_approval','sent')", [s.tenantId, id, last.label]);
        return r.rows[0];
      } catch (e) { this.duplicate(e); }
    });
  }
}

const SELECT_JOIN = `id,label,zone,seats,shape,pos_x "posX",pos_y "posY",span_x "spanX",span_y "spanY",merged_from "mergedFrom"`;
