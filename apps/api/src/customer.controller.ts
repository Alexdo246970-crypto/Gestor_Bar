import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Patch, Post, ServiceUnavailableException, TooManyRequestsException, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createHash, randomBytes } from 'node:crypto';
import { DbService } from './db.service';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const validTenantId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

@ApiTags('customer account')
@Controller('public/customer-account/:tenantId')
export class CustomerController {
  constructor(private readonly db: DbService) {}

  private async customer(c: any, tenantId: string, rawToken?: string) {
    if (!rawToken) throw new UnauthorizedException('Inicia sesión con el enlace enviado a tu correo');
    const result = await c.query(`SELECT cs.customer_id "customerId",cu.full_name "fullName",cu.email,cu.preferences
      FROM customer_sessions cs JOIN customers cu ON cu.tenant_id=cs.tenant_id AND cu.id=cs.customer_id
      WHERE cs.tenant_id=$1 AND cs.token_hash=$2 AND cs.expires_at>now() AND cs.revoked_at IS NULL`, [tenantId,hash(rawToken)]);
    if (!result.rows[0]) throw new UnauthorizedException('La sesión ha caducado; solicita otro enlace de acceso');
    return result.rows[0];
  }

  @Post('request-link') async requestLink(@Param('tenantId') tenantId: string, @Body() b: { fullName: string; email: string; consent: boolean; marketingConsent?: boolean; qrToken?: string }) {
    if (!validTenantId(tenantId) || !b?.fullName?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email || '').trim()) || b.consent !== true) {
      throw new BadRequestException('Indica un nombre, un email válido y acepta el uso de datos para gestionar tu cuenta');
    }
    const [qrTenant,qrSecret]=String(b.qrToken||'').split('.');
    if (qrTenant!==tenantId || !qrSecret) throw new BadRequestException('Abre la cuenta desde el QR de una mesa');
    const rawToken=randomBytes(32).toString('base64url'),tokenHash=hash(rawToken);
    const created=await this.db.bootstrap(async c=>{
      await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
      const table=await c.query('SELECT 1 FROM dining_tables WHERE tenant_id=$1 AND qr_token=$2 AND active',[tenantId,qrSecret]);
      if(!table.rowCount)throw new BadRequestException('El QR no es válido o la mesa está desactivada');
      const customer=(await c.query(`INSERT INTO customers(tenant_id,full_name,email,consent_at,marketing_consent)
        VALUES($1,$2,lower($3),now(),$4) ON CONFLICT(tenant_id,lower(email)) DO UPDATE SET
        full_name=excluded.full_name,consent_at=now(),marketing_consent=excluded.marketing_consent,updated_at=now()
        RETURNING id,email`,[tenantId,b.fullName.trim(),b.email.trim(),b.marketingConsent===true])).rows[0];
      const recent=await c.query(`SELECT 1 FROM customer_login_tokens WHERE tenant_id=$1 AND customer_id=$2
        AND created_at>now()-interval '60 seconds' LIMIT 1`,[tenantId,customer.id]);
      if(recent.rowCount)throw new TooManyRequestsException('Espera un minuto antes de solicitar otro enlace');
      await c.query('UPDATE customer_login_tokens SET used_at=now() WHERE tenant_id=$1 AND customer_id=$2 AND used_at IS NULL',[tenantId,customer.id]);
      await c.query(`INSERT INTO customer_login_tokens(tenant_id,customer_id,token_hash,expires_at)
        VALUES($1,$2,$3,now()+interval '15 minutes')`,[tenantId,customer.id,tokenHash]);
      return {email:customer.email};
    });
    const apiKey=process.env.RESEND_API_KEY,from=process.env.EMAIL_FROM,appUrl=process.env.PUBLIC_APP_URL;
    if(!apiKey||!from||!appUrl){
      await this.db.bootstrap(async c=>{await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);await c.query('UPDATE customer_login_tokens SET used_at=now() WHERE tenant_id=$1 AND token_hash=$2',[tenantId,tokenHash]);});
      throw new ServiceUnavailableException('El envío de enlaces aún no está configurado en el servidor');
    }
    const link=new URL(appUrl);link.searchParams.set('qr',b.qrToken!);link.searchParams.set('customerLogin',rawToken);
    let sent=false;
    try {
      const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:[created.email],subject:'Tu enlace de acceso al bar',html:`<p>Usa este enlace para iniciar sesión en tu cuenta de cliente. Caduca en 15 minutos.</p><p><a href="${link.toString()}">Acceder a mi cuenta</a></p><p>Si no solicitaste este enlace, puedes ignorar este correo.</p>`})});
      sent=response.ok;
    } catch { sent=false; }
    if(!sent){
      await this.db.bootstrap(async c=>{await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);await c.query('UPDATE customer_login_tokens SET used_at=now() WHERE tenant_id=$1 AND token_hash=$2',[tenantId,tokenHash]);});
      throw new ServiceUnavailableException('No se pudo enviar el enlace ahora; inténtalo de nuevo más tarde');
    }
    return {ok:true,message:'Si la dirección es válida, recibirás un enlace de acceso que caduca en 15 minutos.'};
  }

  @Get('verify/:token') async verify(@Param('tenantId') tenantId:string,@Param('token') token:string) {
    if(!validTenantId(tenantId))throw new BadRequestException('Cuenta no válida');
    const sessionToken=randomBytes(32).toString('base64url');
    return this.db.bootstrap(async c=>{
      await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
      const login=await c.query(`SELECT id,customer_id "customerId" FROM customer_login_tokens
        WHERE tenant_id=$1 AND token_hash=$2 AND used_at IS NULL AND expires_at>now() FOR UPDATE`,[tenantId,hash(token)]);
      if(!login.rows[0])throw new UnauthorizedException('El enlace ha caducado o ya se ha usado');
      await c.query('UPDATE customer_login_tokens SET used_at=now() WHERE tenant_id=$1 AND id=$2',[tenantId,login.rows[0].id]);
      await c.query(`INSERT INTO customer_sessions(tenant_id,customer_id,token_hash,expires_at)
        VALUES($1,$2,$3,now()+interval '30 days')`,[tenantId,login.rows[0].customerId,hash(sessionToken)]);
      const customer=(await c.query('SELECT full_name "fullName",email,preferences FROM customers WHERE tenant_id=$1 AND id=$2',[tenantId,login.rows[0].customerId])).rows[0];
      return {sessionToken,customer};
    });
  }

  @Get('history') async history(@Param('tenantId') tenantId:string,@Headers('x-customer-session-token') rawToken:string) {
    if(!validTenantId(tenantId))throw new BadRequestException('Cuenta no válida');
    return this.db.bootstrap(async c=>{
      await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
      const customer=await this.customer(c,tenantId,rawToken);
      const orders=await c.query(`SELECT o.id,o.order_number "orderNumber",o.table_label "tableLabel",o.opened_at "openedAt",o.gross_total "grossTotal",
        json_agg(json_build_object('productId',l.product_id,'name',l.product_name,'quantity',l.quantity,'available',p.active) ORDER BY l.id) lines
        FROM orders o JOIN order_lines l ON l.tenant_id=o.tenant_id AND l.order_id=o.id
        LEFT JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id
        WHERE o.tenant_id=$1 AND o.customer_id=$2 AND o.channel='qr' AND o.status IN ('sent','paid')
          AND o.opened_at>=now()-interval '12 months'
        GROUP BY o.id ORDER BY o.opened_at DESC`,[tenantId,customer.customerId]);
      return {customer:{fullName:customer.fullName,email:customer.email,preferences:customer.preferences},orders:orders.rows};
    });
  }

  @Patch('preferences') async updatePreferences(@Param('tenantId') tenantId:string,@Headers('x-customer-session-token') rawToken:string,@Body() b:{preferences:string}) {
    if(!validTenantId(tenantId)||typeof b?.preferences!=='string'||b.preferences.length>500)throw new BadRequestException('Las preferencias no pueden superar 500 caracteres');
    return this.db.bootstrap(async c=>{
      await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
      const customer=await this.customer(c,tenantId,rawToken);
      const result=await c.query('UPDATE customers SET preferences=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING preferences',[tenantId,customer.customerId,b.preferences.trim()||null]);
      await c.query(`UPDATE orders SET customer_preferences=$3 WHERE tenant_id=$1 AND customer_id=$2 AND status IN ('open','pending_approval','sent')`,[tenantId,customer.customerId,result.rows[0].preferences]);
      return {preferences:result.rows[0].preferences};
    });
  }

  @Delete('account') async deleteAccount(@Param('tenantId') tenantId:string,@Headers('x-customer-session-token') rawToken:string) {
    if(!validTenantId(tenantId))throw new BadRequestException('Cuenta no válida');
    return this.db.bootstrap(async c=>{
      await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
      const customer=await this.customer(c,tenantId,rawToken);
      await c.query(`UPDATE orders SET customer_id=NULL,customer_name='Cliente eliminado',customer_email=NULL,customer_preferences=NULL
        WHERE tenant_id=$1 AND customer_id=$2`,[tenantId,customer.customerId]);
      await c.query('DELETE FROM customers WHERE tenant_id=$1 AND id=$2',[tenantId,customer.customerId]);
      return {ok:true};
    });
  }
}
