import { FormEvent, useEffect, useState } from 'react';
import { DEMO, euro, request } from './lib';

type Account = { id: string; kind: 'cash' | 'bank'; name: string; initialBalance: number; iban: string | null; balance: number };
type Commitment = { id: string; description: string; amount: number; dueDate: string | null; account: string };
type Evolution = { date: string; account: string; income: number | null; expense: number | null };
type Summary = { accounts: Account[]; total: number; commitments: Commitment[]; committed: number; availableReal: number; evolution: Evolution[]; cashClosure: { expectedCash: number; countedCash: number; cashDifference: number } | null };

export function TreasuryView({ canManage, cashierOnly }: { canManage: boolean; cashierOnly: boolean }) {
  const [days, setDays] = useState(30), [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [showAccount, setShowAccount] = useState(false), [showTransfer, setShowTransfer] = useState(false), [showCommitment, setShowCommitment] = useState(false);

  async function load() {
    if (DEMO) { setData({ accounts: [], total: 0, commitments: [], committed: 0, availableReal: 0, evolution: [], cashClosure: null }); return; }
    try { setData(await request<Summary>(`/treasury/summary?days=${days}`)); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [days]);

  async function act(url: string, body: object = {}, message = 'Operación registrada.') {
    try { await request(url, { method: 'POST', body: JSON.stringify(body) }); setNotice(message); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function addAccount(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await act('/treasury/accounts', { kind: String(f.get('kind')), name: String(f.get('name')), initialBalance: Number(f.get('initialBalance') || 0), iban: String(f.get('iban') || ''), reason: String(f.get('reason') || '') }, 'Cuenta creada.');
    setShowAccount(false);
  }
  async function transfer(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await act('/treasury/transfers', { fromId: String(f.get('fromId')), toId: String(f.get('toId')), amount: Number(f.get('amount')), date: String(f.get('date') || ''), allowNegative: f.get('allowNegative') === 'on', reason: String(f.get('reason') || '') }, 'Traspaso registrado; el total no cambia.');
    setShowTransfer(false);
  }
  async function addCommitment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await act('/treasury/commitments', { description: String(f.get('description')), amount: Number(f.get('amount')), dueDate: String(f.get('dueDate') || ''), account: String(f.get('account')) }, 'Compromiso registrado.');
    setShowCommitment(false);
  }

  return <section className="finance-page">
    <div className="section-head"><div><h3>Dinero disponible</h3><p>Saldos por cuenta, compromisos y evolución reciente</p></div>
      {canManage && !DEMO && <><button className="secondary" onClick={() => void act('/treasury/commitments/sync', {}, 'Compromisos sincronizados.')}>Sincronizar</button> <button className="secondary" onClick={() => setShowCommitment(true)}>＋ Compromiso</button> <button className="secondary" onClick={() => setShowTransfer(true)}>⇄ Traspaso</button> <button className="primary" onClick={() => setShowAccount(true)}>＋ Cuenta</button></>}</div>
    {error && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    {notice && <div className="order-notice" onClick={() => setNotice('')}>✓ {notice}</div>}
    {cashierOnly && <p className="finance-note">Vista limitada a la cuenta de caja.</p>}
    <div className="kpi-grid">
      <article><span>Dinero disponible</span><strong>{euro(data?.total ?? 0)}</strong><small>caja + banco</small></article>
      <article><span>Compromisos pendientes</span><strong>{euro(data?.committed ?? 0)}</strong><small>{data?.commitments.length ?? 0} vencimientos</small></article>
      <article><span>Disponible real</span><strong>{euro(data?.availableReal ?? 0)}</strong><small>saldo − compromisos</small></article>
    </div>
    <div className="content-grid"><section><div className="section-head"><div><h3>Cuentas</h3><p>Saldo inicial + movimientos del libro</p></div></div>
      <div className="ledger-lines">{data?.accounts.map(a => <div key={a.id} className="ledger-line"><span>{a.name}</span><small>{a.kind}{a.iban ? ` · ${a.iban}` : ''} · inicial {euro(a.initialBalance)}</small><b>{euro(a.balance)}</b></div>)}{!data?.accounts.length && <p className="finance-note">Crea una cuenta de caja y otra de banco.</p>}</div>
      {data?.cashClosure && <p className="finance-note">Último cierre: esperado {euro(data.cashClosure.expectedCash)} · contado {euro(data.cashClosure.countedCash)} · diferencia {euro(data.cashClosure.cashDifference)}</p>}
    </section><section><div className="section-head"><div><h3>Próximos vencimientos</h3><p>Facturas y nóminas pendientes</p></div></div>
      <div className="ledger-lines">{data?.commitments.map(c => <div key={c.id} className="ledger-line"><span>{c.description}</span><small>{c.account} · {c.dueDate || 'sin fecha'}</small><b>{euro(c.amount)}</b>
        {canManage && !DEMO && <button className="secondary" onClick={() => void act(`/treasury/commitments/${c.id}/pay`, {}, 'Compromiso marcado como pagado.')}>Pagado</button>}</div>)}{!data?.commitments.length && <p className="finance-note">Sin compromisos pendientes.</p>}</div>
    </section></div>
    <div className="section-head"><div><h3>Evolución</h3><p>Movimientos de los últimos {days} días</p></div><select value={days} onChange={e => setDays(Number(e.target.value))}><option value={30}>30 días</option><option value={90}>90 días</option></select></div>
    <div className="ledger-lines">{data?.evolution.map((e, i) => <div key={i} className="ledger-line"><span>{e.date}</span><small>{e.account}</small><small>+{euro(e.income ?? 0)}</small><b>−{euro(e.expense ?? 0)}</b></div>)}{!data?.evolution.length && <p className="finance-note">Sin movimientos en el periodo.</p>}</div>

    {showAccount && <div className="modal-backdrop"><form className="modal-card" onSubmit={addAccount}>
      <div className="section-head"><div><h3>Nueva cuenta</h3><p>Una activa por tipo</p></div></div>
      <label>Tipo<select name="kind"><option value="cash">Caja</option><option value="bank">Banco</option></select></label>
      <label>Nombre<input name="name" required /></label>
      <div className="form-pair"><label>Saldo inicial<input name="initialBalance" type="number" step="0.01" defaultValue={0} /></label><label>IBAN<input name="iban" /></label></div>
      <label>Motivo (si saldo negativo)<input name="reason" /></label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setShowAccount(false)}>Cancelar</button><button className="primary">Crear</button></div>
    </form></div>}
    {showTransfer && <div className="modal-backdrop"><form className="modal-card" onSubmit={transfer}>
      <div className="section-head"><div><h3>Traspaso entre cuentas</h3><p>No cuenta como ingreso ni gasto</p></div></div>
      <div className="form-pair"><label>Desde<select name="fromId" required>{data?.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>Hacia<select name="toId" required>{data?.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label></div>
      <div className="form-pair"><label>Importe<input name="amount" type="number" min="0.01" step="0.01" required /></label><label>Fecha<input name="date" type="date" /></label></div>
      <label className="checkbox-line"><input type="checkbox" name="allowNegative" /> Permitir saldo negativo</label>
      <label>Motivo<input name="reason" /></label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setShowTransfer(false)}>Cancelar</button><button className="primary">Traspasar</button></div>
    </form></div>}
    {showCommitment && <div className="modal-backdrop"><form className="modal-card" onSubmit={addCommitment}>
      <div className="section-head"><div><h3>Nuevo compromiso</h3><p>Pago previsto con vencimiento</p></div></div>
      <label>Descripción<input name="description" required /></label>
      <div className="form-pair"><label>Importe<input name="amount" type="number" min="0.01" step="0.01" required /></label><label>Vencimiento<input name="dueDate" type="date" /></label></div>
      <label>Cuenta<select name="account"><option value="bank">Banco</option><option value="cash">Caja</option></select></label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setShowCommitment(false)}>Cancelar</button><button className="primary">Guardar</button></div>
    </form></div>}
  </section>;
}
