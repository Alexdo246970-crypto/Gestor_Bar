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
import { RoomsController } from './rooms.controller';
import { LedgerController } from './ledger.controller';
import { LossesController } from './losses.controller';
import { IncomeController } from './income.controller';
import { TreasuryController } from './treasury.controller';
import { TaxesController } from './taxes.controller';
import { SalariesController } from './salaries.controller';
import { PurchasesController, SuppliersController } from './purchases.controller';
import { KitchenController } from './kitchen.controller';
import { StaffController } from './staff.controller';
import { CustomerController } from './customer.controller';

@Module({ controllers: [AuthController, CoreController, CustomerController, CatalogController, OrdersController, InventoryController, PurchasesController, SuppliersController, FinanceController, TablesController, LedgerController, RoomsController, SalariesController, TaxesController, TreasuryController, IncomeController, LossesController, KitchenController, StaffController],
  providers: [{ provide: 'PG_POOL', useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }) }, DbService] })
export class AppModule {}
