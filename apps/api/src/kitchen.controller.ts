import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

@ApiTags('kitchen')
@Controller()
export class KitchenController {
  constructor(private readonly db: DbService) {}
  private session(req: AuthRequest, managers = false) {
    const s=req.session?.app;
    if(!s) throw new UnauthorizedException();
    if(managers ? !['admin','manager'].includes(s.role) : !['admin','manager','waiter','kitchen'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }
  @Get('kitchen/orders') async orders(@Req() req:AuthRequest) {
    const s=this.session(req);
    return this.db.tenant(req,async c=>(await c.query(`SELECT o.id,o.order_number "orderNumber",o.table_label "tableLabel",o.channel,o.opened_at "openedAt",
      json_agg(json_build_object('id',l.id,'name',l.product_name,'quantity',l.quantity,'kitchenStatus',l.kitchen_status,'modifications',coalesce((SELECT json_agg(json_build_object('action',m.action,'ingredient',i.name)) FROM order_line_modifications m JOIN ingredients i ON i.tenant_id=m.tenant_id AND i.id=m.ingredient_id WHERE m.tenant_id=l.tenant_id AND m.order_line_id=l.id),'[]'::json)) ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL) lines
      FROM orders o LEFT JOIN order_lines l ON l.tenant_id=o.tenant_id AND l.order_id=o.id WHERE o.tenant_id=$1 AND o.status='sent'
      GROUP BY o.id HAVING bool_or(l.kitchen_status<>'ready') ORDER BY o.opened_at`,[s.tenantId])).rows);
  }
  @Patch('kitchen/lines/:id/status') async lineStatus(@Req() req:AuthRequest,@Param('id') id:string,@Body() b:{status:string}) {
    const s=this.session(req);
    if(!['received','preparing','ready'].includes(b?.status)) throw new BadRequestException('Estado de cocina no válido');
    return this.db.tenant(req,async c=>{const r=await c.query("UPDATE order_lines l SET kitchen_status=$3 FROM orders o WHERE l.tenant_id=$1 AND l.id=$2 AND o.tenant_id=l.tenant_id AND o.id=l.order_id AND o.status='sent' RETURNING l.id,l.kitchen_status",[s.tenantId,id,b.status]);if(!r.rowCount)throw new BadRequestException('Plato de cocina no encontrado');return r.rows[0]});
  }
  @Get('kitchen/settings') async settings(@Req() req:AuthRequest) { const s=this.session(req);return this.db.tenant(req,async c=>{await c.query('INSERT INTO tenant_kitchen_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING',[s.tenantId]);return (await c.query('SELECT printer_name "printerName",printer_mode "printerMode",printer_host "printerHost",printer_port "printerPort",ticket_autoprint "ticketAutoprint" FROM tenant_kitchen_settings WHERE tenant_id=$1',[s.tenantId])).rows[0]}); }
  @Patch('kitchen/settings') async updateSettings(@Req() req:AuthRequest,@Body() b:any) { const s=this.session(req);if(!['browser','network'].includes(b?.printerMode)||!Number.isInteger(Number(b?.printerPort))||Number(b.printerPort)<1||Number(b.printerPort)>65535)throw new BadRequestException('Configuración de impresora no válida');return this.db.tenant(req,async c=>(await c.query(`INSERT INTO tenant_kitchen_settings(tenant_id,printer_name,printer_mode,printer_host,printer_port,ticket_autoprint) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id) DO UPDATE SET printer_name=excluded.printer_name,printer_mode=excluded.printer_mode,printer_host=excluded.printer_host,printer_port=excluded.printer_port,ticket_autoprint=excluded.ticket_autoprint,updated_at=now() RETURNING printer_name "printerName",printer_mode "printerMode",printer_host "printerHost",printer_port "printerPort",ticket_autoprint "ticketAutoprint"`,[s.tenantId,b.printerName||null,b.printerMode,b.printerHost||null,Number(b.printerPort),Boolean(b.ticketAutoprint)])).rows[0])); }
  @Post('staff/temporary-waiters') async createTemporary(@Req() req:AuthRequest,@Body() b:{email:string;fullName:string;password:string;expiresAt:string}) {
    const s=this.session(req,true);const expiry=new Date(b?.expiresAt);
    if(!b?.email||!b.fullName||!b.password||b.password.length<12||!Number.isFinite(expiry.getTime())||expiry<=new Date())throw new BadRequestException('Indica nombre, email, contraseña de 12 caracteres y una fecha futura');
    return this.db.tenant(req,async c=>{const existing=await c.query('SELECT id FROM users WHERE lower(email)=lower($1)',[b.email]);if(existing.rows[0])throw new BadRequestException('Ese email ya está registrado');const argon2=await import('argon2');const u=await c.query('INSERT INTO users(email,password_hash,full_name,expires_at) VALUES(lower($1),$2,$3,$4) RETURNING id,email,full_name "fullName",expires_at "expiresAt"',[b.email,await argon2.hash(b.password),b.fullName,expiry]);await c.query("INSERT INTO tenant_users(tenant_id,user_id,role) VALUES($1,$2,'waiter')",[s.tenantId,u.rows[0].id]);return u.rows[0]});
  }
}
