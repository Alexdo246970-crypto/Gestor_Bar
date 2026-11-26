import { FormEvent, useEffect, useState } from 'react';
import { DEMO, euro, request } from './lib';

type Employee = { id: string; name: string; taxId: string | null; position: string | null; leftAt: string | null; paymentAccount: string | null };
type Entry = { id: string; month: string; status: string; gross: number; net: number; socialSecurityCompany: number; socialSecurityWorker: number; irpfWithheld: number; otherConcepts: number; paymentDate: string | null; paidAt: string | null; employeeId: string; employeeName: string; position: string | null };
type Result = { lines?: Entry[]; totals: { gross: number; net: number; socialSecurityCompany: number; cost: number } };

export function SalariesView({ canManage }: { canManage: boolean }) {
  const [month, setMonth] = useState(new Date().toLocaleDateString('en-CA').slice(0, 7));
  const [employees, setEmployees] = useState<Employee[]>([]), [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [showEmployee, setShowEmployee] = useState(false), [showSalary, setShowSalary] = useState(false);

  async function load() {
    try {
      const payroll = await request<Result>(`/salaries?month=${month}`);
      setData(payroll);
      if (canManage) setEmployees(await request<Employee[]>('/employees'));
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [month]);

  async function act(url: string, body: object = {}) {
    try { await request(url, { method: 'POST', body: JSON.stringify(body) }); setNotice('Operación registrada.'); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function addEmployee(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await act('/employees', { name: String(f.get('name')), taxId: String(f.get('taxId') || ''), position: String(f.get('position') || ''), hiredAt: String(f.get('hiredAt') || ''), paymentAccount: String(f.get('paymentAccount') || '') });
    setShowEmployee(false);
  }
  async function addSalary(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await act('/salaries', {
      employeeId: String(f.get('employeeId')), month, gross: Number(f.get('gross')),
      socialSecurityCompany: Number(f.get('socialSecurityCompany') || 0), socialSecurityWorker: Number(f.get('socialSecurityWorker') || 0),
      irpfWithheld: Number(f.get('irpfWithheld') || 0), otherConcepts: Number(f.get('otherConcepts') || 0),
      paymentDate: String(f.get('paymentDate') || '') || undefined, notes: String(f.get('notes') || '')
    });
    setShowSalary(false);
  }

  const active = employees.filter(e => !e.leftAt || e.leftAt.slice(0, 7) >= month);
  return <section className="finance-page">
    <div className="section-head"><div><h3>Nóminas y personal</h3><p>{canManage ? 'Coste real de plantilla y su efecto en cuentas' : 'Totales de plantilla; el detalle nominativo está restringido'}</p></div>
      {canManage && <><button className="secondary" onClick={() => setShowEmployee(true)}>＋ Empleado</button> <button className="primary" disabled={!employees.length} onClick={() => setShowSalary(true)}>＋ Nómina</button></>}</div>
    {error && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    {notice && <div className="order-notice" onClick={() => setNotice('')}>✓ {notice}</div>}
    <div className="finance-period"><label>Mes<input type="month" value={month} onChange={e => setMonth(e.target.value)} /></label><span>Las bajas posteriores al mes siguen apareciendo en el histórico</span></div>
    <div className="kpi-grid">
      <article><span>Bruto</span><strong>{euro(data?.totals.gross ?? 0)}</strong><small>{data?.lines?.length ?? 0} nóminas</small></article>
      <article><span>SS empresa</span><strong>{euro(data?.totals.socialSecurityCompany ?? 0)}</strong><small>coste adicional</small></article>
      <article><span>Coste de plantilla</span><strong>{euro(data?.totals.cost ?? 0)}</strong><small>Neto {euro(data?.totals.net ?? 0)}</small></article>
    </div>
    {canManage ? <div className="salary-grid"><section><div className="section-head"><div><h3>Empleados</h3><p>{active.length} activos en el periodo</p></div></div>
      <div className="ledger-lines">{employees.map(e => <div key={e.id} className="ledger-line"><span>{e.name}</span><small>{e.position || 'Sin puesto'}{e.leftAt ? ` · baja ${e.leftAt}` : ''}</small><b>{e.taxId || '—'}</b></div>)}{!employees.length && <p className="finance-note">Aún no hay empleados registrados.</p>}</div>
    </section><section><div className="section-head"><div><h3>Nóminas de {month}</h3><p>El neto se calcula automáticamente</p></div></div>
      <div className="ledger-lines">{data?.lines?.map(s => <div key={s.id} className="salary-line">
        <strong>{s.employeeName}</strong><span>{s.status === 'draft' ? 'Borrador' : s.status === 'paid' ? 'Pagada' : s.status === 'void' ? 'Anulada' : 'Confirmada'}</span>
        <small>Bruto {euro(s.gross)}</small><small>Net {euro(s.net)}</small><small>Coste {euro(s.gross + s.socialSecurityCompany)}</small>
        {s.status === 'draft' && <button className="secondary" onClick={() => void act(`/salaries/${s.id}/confirm`)}>Confirmar</button>}
        {s.status === 'confirmed' && <button className="secondary" onClick={() => void act(`/salaries/${s.id}/pay`, { paidAt: new Date().toLocaleDateString('en-CA') })}>Marcar pagada</button>}
        {['confirmed', 'paid'].includes(s.status) && <button className="remove-button" onClick={() => { const reason = window.prompt('Motivo de la anulación'); if (reason) void act(`/salaries/${s.id}/void`, { reason }); }}>Anular</button>}
      </div>)}{!data?.lines?.length && <p className="finance-note">Sin nóminas en este mes.</p>}</div>
    </section></div> : <p className="finance-note">Acceso restringido a totales. Los importes agregados son los que se contabilizan en cuentas.</p>}

    {showEmployee && <div className="modal-backdrop"><form className="modal-card" onSubmit={addEmployee}>
      <div className="section-head"><div><h3>Nuevo empleado</h3><p>El vínculo con usuario es opcional</p></div></div>
      <label>Nombre<input name="name" required /></label><div className="form-pair"><label>NIF<input name="taxId" /></label><label>Puesto<input name="position" /></label></div>
      <div className="form-pair"><label>Alta<input name="hiredAt" type="date" /></label><label>Cuenta de pago<input name="paymentAccount" /></label></div>
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setShowEmployee(false)}>Cancelar</button><button className="primary">Guardar</button></div>
    </form></div>}
    {showSalary && <div className="modal-backdrop"><form className="modal-card" onSubmit={addSalary}>
      <div className="section-head"><div><h3>Nómina de {month}</h3><p>Importes facilitados por la gestoría</p></div></div>
      <label>Empleado<select name="employeeId" required>{active.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      <div className="form-pair"><label>Salario bruto<input name="gross" type="number" min="0.01" step="0.01" required /></label><label>SS empresa<input name="socialSecurityCompany" type="number" min="0" step="0.01" defaultValue={0} /></label></div>
      <div className="form-pair"><label>SS trabajador<input name="socialSecurityWorker" type="number" min="0" step="0.01" defaultValue={0} /></label><label>IRPF retenido<input name="irpfWithheld" type="number" min="0" step="0.01" defaultValue={0} /></label></div>
      <div className="form-pair"><label>Otros conceptos<input name="otherConcepts" type="number" min="0" step="0.01" defaultValue={0} /></label><label>Fecha de pago<input name="paymentDate" type="date" /></label></div>
      <label>Notas<input name="notes" /></label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setShowSalary(false)}>Cancelar</button><button className="primary">Guardar nómina</button></div>
    </form></div>}
  </section>;
}
