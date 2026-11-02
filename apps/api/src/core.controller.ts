import { BadRequestException, Body, Controller, Get, Post, Req, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as argon2 from 'argon2';
import { DbService, AuthRequest } from './db.service';

@ApiTags('catalog')
@Controller()
export class CoreController {
  constructor(private readonly db: DbService) {}
  @Post('setup') async setup(@Body() b: { tenantName: string; slug: string; fullName: string; email: string; password: string }) {
    if (!b?.tenantName || !b.slug || !b.fullName || !b.email || !b.password || b.password.length < 12) throw new BadRequestException('Datos completos y contraseña de 12 caracteres como mínimo');
    // Setup usa una transacción fuera del contexto tenant solo para bootstrap inicial.
    return this.db.bootstrap(async client => {
      await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const count = await client.query('SELECT count(*)::int n FROM users');
      if (count.rows[0].n > 0) throw new BadRequestException('Setup ya completado');
      const t = await client.query('INSERT INTO tenants(slug,name) VALUES($1,$2) RETURNING id', [b.slug.toLowerCase(), b.tenantName]);
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [t.rows[0].id]);
      const u = await client.query('INSERT INTO users(email,password_hash,full_name) VALUES(lower($1),$2,$3) RETURNING id', [b.email, await argon2.hash(b.password), b.fullName]);
      await client.query("INSERT INTO tenant_users(tenant_id,user_id,role) VALUES($1,$2,'admin')", [t.rows[0].id, u.rows[0].id]);
      return { tenant: b.slug.toLowerCase(), user: b.email };
    });
  }
  @Get('menu') async menu(@Req() req: AuthRequest) {
    try { return await this.db.tenant(req, async c => (await c.query(`SELECT p.id,p.name,p.description,p.category_id "categoryId",p.price_net "priceNet",p.vat_rate "vatRate",c.name "categoryName"
      FROM products p LEFT JOIN categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id WHERE p.active ORDER BY c.sort_order,p.name`)).rows); }
    catch (e) { if ((e as Error).message === 'AUTH_REQUIRED') throw new UnauthorizedException(); throw e; }
  }
  @Post('products') async createProduct(@Req() req: AuthRequest, @Body() b: any) {
    if (!req.session?.app) throw new UnauthorizedException();
    if (!['admin','manager'].includes(req.session.app.role)) throw new ForbiddenException();
    if (!b?.name || !Number.isFinite(b.priceNet) || !Number.isFinite(b.vatRate)) throw new BadRequestException('Nombre, precio neto e IVA son obligatorios');
    return this.db.tenant(req, async c => {
      const result = await c.query(`INSERT INTO products(tenant_id,category_id,name,description,price_net,vat_rate)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,category_id "categoryId",price_net "priceNet",vat_rate "vatRate"`,
        [req.session.app!.tenantId,b.categoryId||null,b.name,b.description||null,b.priceNet,b.vatRate]); return result.rows[0];
    });
  }
}
