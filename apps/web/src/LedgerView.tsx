import { FormEvent, useEffect, useState } from 'react';
import { DEMO, euro, request } from './lib';

type Line = { id: string; date: string; type: 'income' | 'expense'; category: string; account: string; amountNet: number; vat: number; total: number; sourceType: string | null; notes: string | null };
type Totals = { incomeNet: number; incomeVat: number; incomeTotal: number; expenseNet: number; expenseVat: number; expenseTotal: number };
type Result = { lines: Line[]; totals: Totals; byCategory: { category: string; type: string; total: number }[] };

export function LedgerView({ canManage }: { canManage: boolean }) {
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [data, setData] = useState<Result | null>(null), [error, setError] = useState('');
  async function load() {
    if (DEMO) { setData({ lines: [], totals: { incomeNet: 0, incomeVat: 0, incomeTotal: 0, expenseNet: 0, expenseVat: 0, expenseTotal: 0 }, byCategory: [] }); return; }
    try { const q = new URLSearchParams({ from, to }); setData(await request<Result>(`/ledger?${q}`)); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [from, to]);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    try {
      await request('/ledger', { method: 'POST', body: JSON.stringify({
        date: String(f.get('date')), type: String(f.get('type')), category: String(f.get('category')),
        account: String(f.get('account')), amountNet: Number(f.get('amountNet')), vat: Number(f.get('vat')), notes: String(f.get('notes') || '')
      }) });
      e.currentTarget.reset(); await load();
    } catch (err) { setError((err as Error).message); }
  }
  const totals = data?.totals;
  return <section className="finance-page">
    <div className="section-head"><div><h3>Cuentas</h3><p>Libro de movimientos: entradas, salidas y saldo del periodo</p></div></div>
    {error && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    <div className="finance-period"><label>Desde<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>Hasta<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label><span>Rango de fecha de operación</span></div>
    <div className="kpi-grid">
      <article><span>Ingresos netos</span><strong>{euro(totals?.incomeNet ?? 0)}</strong><small>IVA {euro(totals?.incomeVat ?? 0)}</small></article>
      <article><span>Gastos netos</span><strong>{euro(totals?.expenseNet ?? 0)}</strong><small>IVA {euro(totals?.expenseVat ?? 0)}</small></article>
      <article><span>Saldo del periodo</span><strong>{euro((totals?.incomeTotal ?? 0) - (totals?.expenseTotal ?? 0))}</strong><small>total con IVA</small></article>
    </div>
    <div className="content-grid">
      <section><div className="section-head"><div><h3>Movimientos</h3><p>{data?.lines.length ?? 0} apuntes</p></div></div>
        <div className="ledger-lines">{data?.lines.map(l => <div key={l.id} className="ledger-line">
          <span>{l.date}</span><strong>{l.category}</strong><small>{l.account} · {l.sourceType || 'manual'}</small>
          <b className={l.type}>{l.type === 'income' ? '+' : '−'}{euro(l.total)}</b>
        </div>)}{!data?.lines.length && <p className="finance-note">Sin movimientos en este periodo.</p>}</div>
      </section>
      {canManage && !DEMO && <aside><div className="section-head"><div><h3>Nuevo apunte</h3><p>Ingreso o gasto manual</p></div></div>
        <form onSubmit={create} className="table-form">
          <label>Fecha<input name="date" type="date" required /></label>
          <label>Tipo<select name="type"><option value="expense">Gasto</option><option value="income">Ingreso</option></select></label>
          <label>Categoría<input name="category" required placeholder="Alquiler, suministros…" /></label>
          <label>Cuenta<select name="account"><option value="cash">Caja</option><option value="bank">Banco</option></select></label>
          <div className="form-pair"><label>Base<input name="amountNet" type="number" min="0.01" step="0.01" required /></label><label>IVA<input name="vat" type="number" min="0" step="0.01" defaultValue={0} /></label></div>
          <label>Notas<input name="notes" /></label>
          <button className="primary wide">Guardar movimiento</button>
        </form>
      </aside>}
    </div>
  </section>;
}
