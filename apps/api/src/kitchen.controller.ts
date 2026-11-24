import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Patch, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

type KitchenSettings = {
  printerName: string | null;
  printerMode: 'browser' | 'network';
  printerHost: string | null;
  printerPort: number;
  ticketAutoprint: boolean;
};

@ApiTags('kitchen')
@Controller()
export class KitchenController {
  constructor(private readonly db: DbService) {}

  private session(req: AuthRequest) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin', 'manager', 'waiter', 'kitchen'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }

  /** Comandas enviadas con platos pendientes. Cocina solo ve líneas, modificaciones y tiempos. */
  @Get('kitchen/orders') async orders(@Req() req: AuthRequest) {
    const s = this.session(req);
    return this.db.tenant(req, async c => (await c.query(`SELECT o.id,o.order_number "orderNumber",o.table_label "tableLabel",o.channel,o.opened_at "openedAt",
      json_agg(json_build_object('id',l.id,'name',l.product_name,'quantity',l.quantity,'kitchenStatus',l.kitchen_status,'station',coalesce(p.kitchen_station,'kitchen'),'modifications',coalesce((SELECT json_agg(json_build_object('action',m.action,'ingredient',i.name)) FROM order_line_modifications m JOIN ingredients i ON i.tenant_id=m.tenant_id AND i.id=m.ingredient_id WHERE m.tenant_id=l.tenant_id AND m.order_line_id=l.id),'[]'::json)) ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL) lines
      FROM orders o LEFT JOIN order_lines l ON l.tenant_id=o.tenant_id AND l.order_id=o.id LEFT JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id WHERE o.tenant_id=$1 AND o.status='sent'
      GROUP BY o.id ORDER BY o.opened_at`, [s.tenantId])).rows);
  }

  @Patch('kitchen/lines/:id/status') async lineStatus(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: { status: string }) {
    const s = this.session(req);
    if (!['received', 'preparing', 'ready'].includes(b?.status)) throw new BadRequestException('Estado de cocina no válido');
    return this.db.tenant(req, async c => {
      const r = await c.query("UPDATE order_lines l SET kitchen_status=$3 FROM orders o WHERE l.tenant_id=$1 AND l.id=$2 AND o.tenant_id=l.tenant_id AND o.id=l.order_id AND o.status='sent' RETURNING l.id,l.kitchen_status",
        [s.tenantId, id, b.status]);
      if (!r.rowCount) throw new BadRequestException('Plato de cocina no encontrado');
      return r.rows[0];
    });
  }

  private async readSettings(c: any, tenantId: string): Promise<KitchenSettings> {
    await c.query('INSERT INTO tenant_kitchen_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [tenantId]);
    return (await c.query(`SELECT printer_name "printerName",printer_mode "printerMode",printer_host "printerHost",
      printer_port "printerPort",ticket_autoprint "ticketAutoprint" FROM tenant_kitchen_settings WHERE tenant_id=$1`, [tenantId])).rows[0];
  }

  @Get('kitchen/settings') async settings(@Req() req: AuthRequest) {
    const s = this.session(req);
    return this.db.tenant(req, async c => ({
      ...(await this.readSettings(c, s.tenantId)),
      canEditNetwork: ['admin', 'manager'].includes(s.role),
    }));
  }

  /**
   * Cocina puede cambiar nombre, modo y autoprint. Host/puerto quedan reservados a admin/manager.
   * Cada cambio se registra en kitchen_settings_audit.
   */
  @Patch('kitchen/settings') async updateSettings(@Req() req: AuthRequest, @Body() b: any) {
    const s = this.session(req);
    if (!['browser', 'network'].includes(b?.printerMode)) throw new BadRequestException('Configuración de impresora no válida');
    if (b?.printerPort !== undefined && (!Number.isInteger(Number(b.printerPort)) || Number(b.printerPort) < 1 || Number(b.printerPort) > 65535)) {
      throw new BadRequestException('Configuración de impresora no válida');
    }
    return this.db.tenant(req, async c => {
      const current = await this.readSettings(c, s.tenantId);
      const canEditNetwork = ['admin', 'manager'].includes(s.role);
      const wantsHost = b?.printerHost !== undefined && String(b.printerHost || '') !== String(current.printerHost || '');
      const wantsPort = b?.printerPort !== undefined && Number(b.printerPort) !== Number(current.printerPort);
      if (!canEditNetwork && (wantsHost || wantsPort)) throw new ForbiddenException('Solo admin o manager pueden cambiar host y puerto de la impresora');

      const next: KitchenSettings = {
        printerName: b?.printerName === undefined ? current.printerName : (String(b.printerName).trim() || null),
        printerMode: b.printerMode,
        printerHost: canEditNetwork ? (b?.printerHost === undefined ? current.printerHost : (String(b.printerHost).trim() || null)) : current.printerHost,
        printerPort: canEditNetwork && b?.printerPort !== undefined ? Number(b.printerPort) : Number(current.printerPort),
        ticketAutoprint: b?.ticketAutoprint === undefined ? current.ticketAutoprint : Boolean(b.ticketAutoprint),
      };

      const saved = (await c.query(`INSERT INTO tenant_kitchen_settings(tenant_id,printer_name,printer_mode,printer_host,printer_port,ticket_autoprint)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id) DO UPDATE SET printer_name=excluded.printer_name,printer_mode=excluded.printer_mode,
        printer_host=excluded.printer_host,printer_port=excluded.printer_port,ticket_autoprint=excluded.ticket_autoprint,updated_at=now()
        RETURNING printer_name "printerName",printer_mode "printerMode",printer_host "printerHost",printer_port "printerPort",ticket_autoprint "ticketAutoprint"`,
        [s.tenantId, next.printerName, next.printerMode, next.printerHost, next.printerPort, next.ticketAutoprint])).rows[0];

      await c.query(`INSERT INTO kitchen_settings_audit(tenant_id,changed_by,old_values,new_values) VALUES($1,$2,$3,$4)`,
        [s.tenantId, s.userId, JSON.stringify(current), JSON.stringify(saved)]);

      return { ...saved, canEditNetwork };
    });
  }
}
