import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

const SHAPES = ['square', 'round', 'bar'];
const SQUARE: [number, number][] = [[70, 2], [80, 4], [90, 4], [100, 6], [120, 8]];
type TableBody = { label?: string; zone?: string; seats?: number; shape?: string; posX?: number; posY?: number; widthCm?: number };
type TableRow = { id: string; label: string; zone: string; seats: number; shape: string; posX: number; posY: number; widthCm: number | null; heightCm: number | null; seatsRecommended: number | null };
const COLUMNS = `id,label,zone,seats,shape,pos_x "posX",pos_y "posY",width_cm "widthCm",height_cm "heightCm",seats_recommended "seatsRecommended"`;
const WARNING = `(seats_recommended IS NOT NULL AND abs(seats-seats_recommended)>2) "seatsWarning"`;
const closest = (side: number) => SQUARE.reduce((best, item) => Math.abs(item[0] - side) < Math.abs(best[0] - side) ? item : best)[1];
const num = (value: unknown, fallback: number) => value === undefined || value === null || value === '' ? fallback : Number(value);

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

  /** Solo la mesa cuadrada tiene lado; ancho y alto se guardan iguales. */
  private measures(shape: string, b: TableBody, current?: TableRow) {
    let width: number | null = null, height: number | null = null, recommended: number | null = null;
    if (shape === 'square') {
      width = num(b.widthCm ?? current?.widthCm, 80);
      if (!Number.isInteger(width) || width < 50 || width > 150) throw new BadRequestException('Lado no válido (50-150 cm)');
      height = width;
      recommended = closest(width);
    }
    const seats = b.seats ?? current?.seats ?? recommended ?? 4;
    if (!Number.isInteger(seats) || seats < 1 || seats > 20) throw new BadRequestException('Número de comensales no válido (1-20)');
    return { width, height, recommended, seats };
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

  @Get() async list(@Req() req: AuthRequest) {
    const s = this.session(req);
    return this.db.tenant(req, async c => (await c.query(`
      SELECT ${COLUMNS}, ${WARNING},
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
    const shape = b.shape ?? 'square';
    const m = this.measures(shape, b);
    return this.db.tenant(req, async c => {
      try {
        return (await c.query(`INSERT INTO dining_tables
          (tenant_id,label,zone,seats,shape,pos_x,pos_y,width_cm,height_cm,seats_recommended)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLUMNS}, ${WARNING}`,
          [s.tenantId, b.label!.trim(), b.zone?.trim() || 'Salón', m.seats, shape, b.posX ?? 0, b.posY ?? 0, m.width, m.height, m.recommended])).rows[0];
      } catch (e) { this.duplicate(e); }
    });
  }

  @Patch(':id') async update(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: TableBody) {
    const s = this.session(req, ['admin', 'manager']);
    this.validate(b, true);
    return this.db.tenant(req, async c => {
      const current: TableRow | undefined = (await c.query(`SELECT ${COLUMNS} FROM dining_tables WHERE tenant_id=$1 AND id=$2 AND active`, [s.tenantId, id])).rows[0];
      if (!current) throw new BadRequestException('Mesa no encontrada');
      const shape = b.shape ?? current.shape;
      const m = this.measures(shape, b, current);
      try {
        const r = await c.query(`UPDATE dining_tables SET label=coalesce($3,label),zone=coalesce($4,zone),seats=$5,shape=$6,
            pos_x=coalesce($7,pos_x),pos_y=coalesce($8,pos_y),width_cm=$9,height_cm=$10,seats_recommended=$11
          WHERE tenant_id=$1 AND id=$2 AND active RETURNING ${COLUMNS}, ${WARNING}`,
          [s.tenantId, id, b.label?.trim() ?? null, b.zone?.trim() || null, m.seats, shape, b.posX ?? null, b.posY ?? null, m.width, m.height, m.recommended]);
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
