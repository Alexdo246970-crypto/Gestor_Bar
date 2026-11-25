import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DbService, AuthRequest } from './db.service';

type EmployeeBody = { name?: string; taxId?: string; position?: string; hiredAt?: string; leftAt?: string; userId?: string; paymentAccount?: string; active?: boolean };
type SalaryBody = { employeeId?: string; month?: string; gross?: number; socialSecurityCompany?: number; socialSecurityWorker?: number; irpfWithheld?: number; otherConcepts?: number; paymentDate?: string; notes?: string; confirmDuplicate?: boolean };

const round = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown, fallback = 0) => v === undefined || v === null || v === '' ? fallback : Number(v);

@ApiTags('salaries')
@Controller()
export class SalariesController {
  constructor(private readonly db: DbService) {}

  private session(req: AuthRequest, write = false) {
    const s = req.session?.app;
    if (!s) throw new UnauthorizedException();
    if (!['admin', 'manager', 'cashier'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    if (write && !['admin', 'manager'].includes(s.role)) throw new ForbiddenException('Permiso insuficiente');
    return s;
  }

  private month(value: unknown) {
    const m = String(value || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new BadRequestException('Mes no válido (AAAA-MM)');
    return `${m}-01`;
  }

  @Get('employees') async employees(@Req() req: AuthRequest) {
    this.session(req);
    return this.db.tenant(req, async c => (await c.query(`SELECT id,name,tax_id "taxId",position,hired_at "hiredAt",left_at "leftAt",
        user_id "userId",payment_account "paymentAccount",active FROM employees WHERE tenant_id=$1 ORDER BY active DESC,name`, [req.session!.app!.tenantId])).rows);
  }

  @Post('employees') async addEmployee(@Req() req: AuthRequest, @Body() b: EmployeeBody) {
    const s = this.session(req, true);
    if (!b?.name?.trim()) throw new BadRequestException('El nombre del empleado es obligatorio');
    if (b.leftAt && b.hiredAt && b.leftAt < b.hiredAt) throw new BadRequestException('La baja no puede ser anterior al alta');
    return this.db.tenant(req, async c => (await c.query(`INSERT INTO employees
      (tenant_id,name,tax_id,position,hired_at,left_at,user_id,payment_account) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id,name,tax_id "taxId",position,hired_at "hiredAt",left_at "leftAt",user_id "userId",payment_account "paymentAccount"`,
      [s.tenantId, b.name!.trim(), b.taxId?.trim() || null, b.position?.trim() || null, b.hiredAt || new Date().toISOString().slice(0, 10),
        b.leftAt || null, b.userId || null, b.paymentAccount?.trim() || null])).rows[0]);
  }

  @Patch('employees/:id') async updateEmployee(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: EmployeeBody) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const r = await c.query(`UPDATE employees SET name=coalesce($3,name),tax_id=coalesce($4,tax_id),position=coalesce($5,position),
          left_at=coalesce($6,left_at),payment_account=coalesce($7,payment_account),active=$8
        WHERE tenant_id=$1 AND id=$2 RETURNING id,name,tax_id "taxId",position,left_at "leftAt",payment_account "paymentAccount",active`,
        [s.tenantId, id, b.name?.trim() || null, b.taxId?.trim() || null, b.position?.trim() || null, b.leftAt || null,
          b.paymentAccount?.trim() || null, b.active ?? true]);
      if (!r.rowCount) throw new BadRequestException('Empleado no encontrado');
      return r.rows[0];
    });
  }

  private net(b: SalaryBody) {
    const gross = num(b.gross), ssCompany = num(b.socialSecurityCompany), ssWorker = num(b.socialSecurityWorker);
    const irpf = num(b.irpfWithheld), other = num(b.otherConcepts);
    if (!Number.isFinite(gross) || gross <= 0) throw new BadRequestException('El salario bruto debe ser positivo');
    for (const v of [ssCompany, ssWorker, irpf, other]) if (!Number.isFinite(v) || v < 0) throw new BadRequestException('Los conceptos no pueden ser negativos');
    if (ssWorker + irpf > gross + other) throw new BadRequestException('Las retenciones superan el bruto');
    return { gross: round(gross), ssCompany: round(ssCompany), ssWorker: round(ssWorker), irpf: round(irpf), other: round(other), net: round(gross + other - ssWorker - irpf) };
  }

  @Get('salaries') async salaries(@Req() req: AuthRequest, @Query('month') month?: string, @Query('employeeId') employeeId?: string) {
    this.session(req);
    return this.db.tenant(req, async c => {
      const period = month ? this.month(month) : null;
      const rows = (await c.query(`SELECT s.id,s.month,s.status,s.net,s.gross,s.social_security_company "socialSecurityCompany",
          s.social_security_worker "socialSecurityWorker",s.irpf_withheld "irpfWithheld",s.other_concepts "otherConcepts",
          s.payment_date "paymentDate",s.paid_at "paidAt",s.notes,e.id "employeeId",e.name "employeeName",e.position
        FROM salary_entries s JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id
        WHERE s.tenant_id=$1 AND ($2::date IS NULL OR s.month=$2::date) AND ($3::uuid IS NULL OR s.employee_id=$3::uuid)
        ORDER BY s.month DESC,e.name`, [req.session!.app!.tenantId, period, employeeId || null])).rows;
      const totals = rows.filter(r => r.status !== 'void').reduce((a: any, r: any) => {
        a.gross += Number(r.gross); a.net += Number(r.net); a.company += Number(r.socialSecurityCompany); return a;
      }, { gross: 0, net: 0, company: 0 });
      return { lines: rows, totals: { gross: round(totals.gross), net: round(totals.net), socialSecurityCompany: round(totals.company), cost: round(totals.gross + totals.company) } };
    });
  }

  @Post('salaries') async addSalary(@Req() req: AuthRequest, @Body() b: SalaryBody) {
    const s = this.session(req, true);
    const month = this.month(b.month), m = this.net(b);
    if (!b.employeeId) throw new BadRequestException('Empleado requerido');
    return this.db.tenant(req, async c => {
      const employee = (await c.query('SELECT id,left_at "leftAt" FROM employees WHERE tenant_id=$1 AND id=$2 AND active', [s.tenantId, b.employeeId])).rows[0];
      if (!employee) throw new BadRequestException('Empleado no disponible');
      const left = employee.leftAt ? new Date(employee.leftAt) : null;
      const periodEnd = new Date(new Date(month).setMonth(new Date(month).getMonth() + 1));
      if (left && left < periodEnd) throw new BadRequestException('El empleado dado de baja no puede tener nómina en ese mes');
      const existing = (await c.query("SELECT id FROM salary_entries WHERE tenant_id=$1 AND employee_id=$2 AND month=$3::date AND status<>'void'", [s.tenantId, b.employeeId, month])).rows[0];
      if (existing && !b.confirmDuplicate) throw new BadRequestException('Ya existe una nómina de ese empleado y mes; confirma para crear otra');
      return (await c.query(`INSERT INTO salary_entries
        (tenant_id,employee_id,month,gross,social_security_company,social_security_worker,irpf_withheld,other_concepts,net,payment_date,notes,created_by)
        VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING id,month,status,gross,net,social_security_company "socialSecurityCompany",payment_date "paymentDate"`,
        [s.tenantId, b.employeeId, month, m.gross, m.ssCompany, m.ssWorker, m.irpf, m.other, m.net, b.paymentDate || null, b.notes?.trim() || null, s.userId])).rows[0];
    });
  }

  /** Confirma la nómina: genera bruto y Seguridad Social de empresa como gastos únicos del libro. */
  @Post('salaries/:id/confirm') async confirm(@Req() req: AuthRequest, @Param('id') id: string) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const p = (await c.query("SELECT * FROM salary_entries WHERE tenant_id=$1 AND id=$2 AND status='draft' FOR UPDATE", [s.tenantId, id])).rows[0];
      if (!p) throw new BadRequestException('Nómina no encontrada o ya confirmada');
      const entries: [string, string, number, string][] = [
        ['salary', 'Personal', Number(p.gross), 'Sueldo bruto'],
        ['salary_ss', 'Seguridad Social', Number(p.social_security_company), 'Seguridad Social a cargo de la empresa']
      ];
      for (const [source, category, amount, notes] of entries) {
        if (amount <= 0) continue;
        await c.query(`INSERT INTO ledger_entries(tenant_id,entry_date,entry_type,category,account,amount_net,vat,total,source_type,source_id,reference,notes,created_by)
          VALUES($1,$2,'expense',$3,'bank',$4,0,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (tenant_id,source_type,source_id) DO NOTHING`,
          [s.tenantId, p.month, category, amount, source, id, String(p.month).slice(0, 7), notes, s.userId]);
      }
      await c.query("UPDATE salary_entries SET status='confirmed',confirmed_at=now() WHERE tenant_id=$1 AND id=$2", [s.tenantId, id]);
      return { ok: true, status: 'confirmed' };
    });
  }

  @Post('salaries/:id/pay') async pay(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: { paidAt?: string }) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const r = await c.query("UPDATE salary_entries SET paid_at=coalesce($3::date,paid_at),payment_date=coalesce($3::date,payment_date),status='paid' WHERE tenant_id=$1 AND id=$2 AND status='confirmed' RETURNING id,paid_at \"paidAt\"", [s.tenantId, id, b.paidAt || null]);
      if (!r.rowCount) throw new BadRequestException('Nómina no encontrada o no confirmada');
      return r.rows[0];
    });
  }

  /** Anular deja rastro y compensa el gasto ya contabilizado. */
  @Post('salaries/:id/void') async void(@Req() req: AuthRequest, @Param('id') id: string, @Body() b: { reason?: string }) {
    const s = this.session(req, true);
    return this.db.tenant(req, async c => {
      const p = (await c.query("SELECT * FROM salary_entries WHERE tenant_id=$1 AND id=$2 AND status IN ('confirmed','paid') FOR UPDATE", [s.tenantId, id])).rows[0];
      if (!p) throw new BadRequestException('Solo se pueden anular nóminas confirmadas');
      for (const [source, amount, notes] of [
        ['salary_reversal', Number(p.gross), 'Anulación de sueldo bruto'],
        ['salary_ss_reversal', Number(p.social_security_company), 'Anulación de Seguridad Social']
      ] as [string, number, string][]) {
        if (amount <= 0) continue;
        await c.query(`INSERT INTO ledger_entries(tenant_id,entry_date,entry_type,category,account,amount_net,vat,total,source_type,source_id,notes,created_by)
          VALUES($1,$2,'income','Regularización personal','bank',$3,0,$3,$4,$5,$6,$7)
          ON CONFLICT (tenant_id,source_type,source_id) DO NOTHING`,
          [s.tenantId, p.month, amount, source, id, `${notes}${b.reason ? ` · ${b.reason}` : ''}`, s.userId]);
      }
      await c.query("UPDATE salary_entries SET status='void',notes=coalesce(notes,'') || $3 WHERE tenant_id=$1 AND id=$2", [s.tenantId, id, ` · Anulada: ${b.reason || 'sin motivo'}`]);
      return { ok: true };
    });
  }
}
