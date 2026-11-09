import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { AuthController } from './auth.controller';
import { CoreController } from './core.controller';
import { DbService } from './db.service';
import { OrdersController } from './orders.controller';
import { InventoryController } from './inventory.controller';
import { FinanceController } from './finance.controller';
import { CatalogController } from './catalog.controller';
import { TablesController } from './tables.controller';
import { PurchasesController, SuppliersController } from './purchases.controller';

@Module({ controllers: [AuthController, CoreController, CatalogController, OrdersController, InventoryController, PurchasesController, SuppliersController, FinanceController, TablesController],
  providers: [{ provide: 'PG_POOL', useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }) }, DbService] })
export class AppModule {}
