import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';
import { Socket, isIP } from 'node:net';

type KitchenSettings = {
  printerName: string | null;
  printerMode: 'browser' | 'network';
  printerHost: string | null;
  printerPort: number;
  ticketAutoprint: boolean;
  ticketWidth: 58 | 80;
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

  private isPrivatePrinterHost(host: string) {
    if (isIP(host) !== 4) return false;
    const [a,b] = host.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }

  private async sendEscPos(host:string,port:number,width:58|80,content:string[]) {
    const columns=width===58?32:48;
    const plain=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e]/g,'');
    const wrapped=content.flatMap(line=>{const value=plain(line);const parts:string[]=[];for(let i=0;i<value.length;i+=columns)parts.push(value.slice(i,i+columns));return parts.length?parts:[''];});
    const payload=Buffer.from(`\x1b@\x1ba\x01\x1bE\x01${wrapped[0]||''}\n\x1bE\x00${wrapped.slice(1).join('\n')}\n\n\n\x1dV\x00`,'ascii');
    await new Promise<void>((resolve,reject)=>{const socket=new Socket();let settled=false;const done=(error?:Error)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):resolve()};socket.setTimeout(3000,()=>done(new Error('La impresora agotó el tiempo de espera')));socket.once('error',error=>done(error));socket.connect(port,host,()=>socket.end(payload,()=>done()));});
  }

  private async sendOrderToPrinter(req:AuthRequest,orderId:string,roundKey:string) {
    const s=this.session(req);
    const details=await this.db.tenant(req,async c=>{
      const settings=await this.readSettings(c,s.tenantId);
      if(settings.printerMode!=='network'||!settings.printerHost||!this.isPrivatePrinterHost(settings.printerHost))throw new BadRequestException('Configura una dirección IPv4 privada para la impresora de red');
      const tenant=(await c.query('SELECT name FROM tenants WHERE id=$1',[s.tenantId])).rows[0];
      const order=(await c.query('SELECT id,order_number "orderNumber",table_label "tableLabel",opened_at "openedAt",status FROM orders WHERE tenant_id=$1 AND id=$2',[s.tenantId,orderId])).rows[0];
      if(!order)throw new BadRequestException('Comanda no encontrada');
      const lines=(await c.query(`SELECT l.product_name "productName",l.quantity,coalesce((SELECT json_agg(json_build_object('action',m.action,'ingredient',i.name) ORDER BY i.name) FROM order_line_modifications m JOIN ingredients i ON i.tenant_id=m.tenant_id AND i.id=m.ingredient_id WHERE m.tenant_id=l.tenant_id AND m.order_line_id=l.id),'[]'::json) modifications FROM order_lines l WHERE l.tenant_id=$1 AND l.order_id=$2 ORDER BY l.id`,[s.tenantId,orderId])).rows;
      if(!lines.length)throw new BadRequestException('La comanda no tiene líneas para imprimir');
      const job=(await c.query(`INSERT INTO kitchen_print_jobs(tenant_id,order_id,round_key) VALUES($1,$2,$3) ON CONFLICT(tenant_id,order_id,round_key) DO NOTHING RETURNING id`,[s.tenantId,orderId,roundKey])).rows[0];
      let jobId=job?.id||null;if(!jobId){const existing=(await c.query(`SELECT id,status,attempts,created_at FROM kitchen_print_jobs WHERE tenant_id=$1 AND order_id=$2 AND round_key=$3 FOR UPDATE`,[s.tenantId,orderId,roundKey])).rows[0];if(existing?.status==='failed'&&Number(existing.attempts)<3&&Date.now()-new Date(existing.created_at).getTime()>15000){await c.query("UPDATE kitchen_print_jobs SET status='pending',last_error=NULL WHERE tenant_id=$1 AND id=$2",[s.tenantId,existing.id]);jobId=existing.id;}}
      return{settings,tenantName:tenant.name,order,lines,jobId};
    });
    if(!details.jobId)return{ok:true,duplicate:true};
    const ticket=[details.tenantName,`COMANDA #${details.order.orderNumber}`,details.order.tableLabel||'Para llevar',new Date(details.order.openedAt).toLocaleString('es-ES'),'--------------------------------'];
    for(const line of details.lines){ticket.push(`${line.quantity} x ${line.productName}`);for(const m of line.modifications||[])ticket.push(`  ${m.action==='remove'?'SIN':'EXTRA'} ${m.ingredient}`);}
    ticket.push('--------------------------------',`Estado: ${details.order.status}`);
    try{await this.sendEscPos(details.settings.printerHost!,Number(details.settings.printerPort),details.settings.ticketWidth,ticket);await this.db.tenant(req,c=>c.query("UPDATE kitchen_print_jobs SET status='printed',attempts=attempts+1,printed_at=now(),last_error=NULL WHERE tenant_id=$1 AND id=$2",[s.tenantId,details.jobId]).then(()=>undefined));return{ok:true};}
    catch(error){const message=(error as Error).message;await this.db.tenant(req,c=>c.query("UPDATE kitchen_print_jobs SET status='failed',attempts=attempts+1,last_error=$3 WHERE tenant_id=$1 AND id=$2",[s.tenantId,details.jobId,message]).then(()=>undefined));throw new BadRequestException(`No se pudo imprimir: ${message}`);}
  }

  /** Comandas enviadas con platos pendientes. Cocina solo ve líneas, modificaciones y tiempos. */
  @Get('kitchen/orders') async orders(@Req() req: AuthRequest) {
    const s = this.session(req);
    const orders=await this.db.tenant(req, async c => (await c.query(`SELECT o.id,o.order_number "orderNumber",o.table_label "tableLabel",o.channel,o.opened_at "openedAt",
      json_agg(json_build_object('id',l.id,'name',l.product_name,'quantity',l.quantity,'kitchenStatus',l.kitchen_status,'modifications',coalesce((SELECT json_agg(json_build_object('action',m.action,'ingredient',i.name)) FROM order_line_modifications m JOIN ingredients i ON i.tenant_id=m.tenant_id AND i.id=m.ingredient_id WHERE m.tenant_id=l.tenant_id AND m.order_line_id=l.id),'[]'::json)) ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL) lines
      FROM orders o LEFT JOIN order_lines l ON l.tenant_id=o.tenant_id AND l.order_id=o.id WHERE o.tenant_id=$1 AND o.status='sent'
      GROUP BY o.id HAVING bool_or(l.kitchen_status<>'ready') ORDER BY o.opened_at`, [s.tenantId])).rows);
    const settings=await this.db.tenant(req,c=>this.readSettings(c,s.tenantId));
    if(settings.ticketAutoprint&&settings.printerMode==='network'&&settings.printerHost){
      for(const order of orders){
        const roundKey=await this.db.tenant(req,async c=>(await c.query(`SELECT md5(coalesce(string_agg(l.id::text||':'||l.quantity::text,',' ORDER BY l.id),'')) value FROM order_lines l WHERE l.tenant_id=$1 AND l.order_id=$2`,[s.tenantId,order.id])).rows[0].value);
        try{await this.sendOrderToPrinter(req,order.id,`${roundKey}:auto`)}catch{/* La comanda sigue disponible en la tableta aunque falle la impresora. */}
      }
    }
    return orders;
  }

  @Post('kitchen/orders/:id/print') async printOrder(@Req() req:AuthRequest,@Param('id') id:string){this.session(req);const s=req.session!.app!;const roundKey=await this.db.tenant(req,async c=>(await c.query(`SELECT md5(coalesce(string_agg(l.id::text||':'||l.quantity::text,',' ORDER BY l.id),'')) value FROM order_lines l WHERE l.tenant_id=$1 AND l.order_id=$2`,[s.tenantId,id])).rows[0].value);return this.sendOrderToPrinter(req,id,`${roundKey}:manual:${Date.now()}`);}

  @Post('kitchen/printer/test') async testPrinter(@Req() req:AuthRequest){this.session(req);const s=req.session!.app!;const settings=await this.db.tenant(req,c=>this.readSettings(c,s.tenantId));if(settings.printerMode!=='network'||!settings.printerHost||!this.isPrivatePrinterHost(settings.printerHost))throw new BadRequestException('Configura una dirección IPv4 privada para la impresora de red');const name=await this.db.tenant(req,async c=>(await c.query('SELECT name FROM tenants WHERE id=$1',[s.tenantId])).rows[0].name);await this.sendEscPos(settings.printerHost,Number(settings.printerPort),settings.ticketWidth,[name,'PRUEBA DE IMPRESORA',new Date().toLocaleString('es-ES'),'Si puedes leer esto, funciona.']);return{ok:true};}

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
      printer_port "printerPort",ticket_autoprint "ticketAutoprint",ticket_width "ticketWidth" FROM tenant_kitchen_settings WHERE tenant_id=$1`, [tenantId])).rows[0];
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
    if (b?.ticketWidth !== undefined && ![58,80].includes(Number(b.ticketWidth))) throw new BadRequestException('El ancho de ticket debe ser 58 u 80 mm');
    if(b?.printerHost&&b?.printerMode==='network'&&!this.isPrivatePrinterHost(String(b.printerHost).trim()))throw new BadRequestException('Usa una dirección IPv4 privada de la red local');
    return this.db.tenant(req, async c => {
      const current = await this.readSettings(c, s.tenantId);
      const canEditNetwork = ['admin', 'manager'].includes(s.role);
      const wantsHost = b?.printerHost !== undefined && String(b.printerHost || '') !== String(current.printerHost || '');
      const wantsPort = b?.printerPort !== undefined && Number(b.printerPort) !== Number(current.printerPort);
      const wantsWidth = b?.ticketWidth !== undefined && Number(b.ticketWidth) !== Number(current.ticketWidth);
      if (!canEditNetwork && (wantsHost || wantsPort || wantsWidth)) throw new ForbiddenException('Solo admin o manager pueden cambiar host, puerto y ancho de ticket');

      const next: KitchenSettings = {
        printerName: b?.printerName === undefined ? current.printerName : (String(b.printerName).trim() || null),
        printerMode: b.printerMode,
        printerHost: canEditNetwork ? (b?.printerHost === undefined ? current.printerHost : (String(b.printerHost).trim() || null)) : current.printerHost,
        printerPort: canEditNetwork && b?.printerPort !== undefined ? Number(b.printerPort) : Number(current.printerPort),
        ticketAutoprint: b?.ticketAutoprint === undefined ? current.ticketAutoprint : Boolean(b.ticketAutoprint),
        ticketWidth: canEditNetwork && b?.ticketWidth !== undefined ? Number(b.ticketWidth) as 58|80 : current.ticketWidth,
      };

      const saved = (await c.query(`INSERT INTO tenant_kitchen_settings(tenant_id,printer_name,printer_mode,printer_host,printer_port,ticket_autoprint,ticket_width)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id) DO UPDATE SET printer_name=excluded.printer_name,printer_mode=excluded.printer_mode,
        printer_host=excluded.printer_host,printer_port=excluded.printer_port,ticket_autoprint=excluded.ticket_autoprint,ticket_width=excluded.ticket_width,updated_at=now()
        RETURNING printer_name "printerName",printer_mode "printerMode",printer_host "printerHost",printer_port "printerPort",ticket_autoprint "ticketAutoprint",ticket_width "ticketWidth"`,
        [s.tenantId, next.printerName, next.printerMode, next.printerHost, next.printerPort, next.ticketAutoprint,next.ticketWidth])).rows[0];

      await c.query(`INSERT INTO kitchen_settings_audit(tenant_id,changed_by,old_values,new_values) VALUES($1,$2,$3,$4)`,
        [s.tenantId, s.userId, JSON.stringify(current), JSON.stringify(saved)]);

      return { ...saved, canEditNetwork };
    });
  }
}
