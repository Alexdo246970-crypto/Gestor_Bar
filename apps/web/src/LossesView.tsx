import { FormEvent, useEffect, useState } from 'react';
import { DEMO, euro, request } from './lib';

type Line = { id: string; date: string; reason: string; amount: number; productName: string; employeeName: string | null; sourceType: string; notes: string | null; signedAmount?: number; quantity?: number };
type Result = {
  from: string; to: string; total: number; lines: Line[];
  byReason: { reason: string; amount: number }[]; byProduct: { product: string; amount: number }[]; byEmployee: { employee: string; amount: number }[];
  salesNet: number; percentOfSales: number | null; thresholdPct: number; alert: boolean; reasons: string[];
};
const REASON_LABEL: Record<string, string> = { waste: 'Merma', breakage: 'Rotura', staff_meal: 'Comida personal', invitation: 'Invitación', count_error: 'Descuadre', expiry: 'Caducidad', other: 'Otro' };

export function LossesView({ canManage }: { canManage: boolean }) {
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`), [to, setTo] = useState(new Date().toLocaleDateString('en-CA'));
  const [data, setData] = useState<Result | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [showInvitation, setShowInvitation] = useState(false);

  async function load() {
    try { setData(await request<Result>(`/reports/losses?from=${from}&to=${to}`)); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [from, to]);

  async function act(url: string, body: object = {}) {
    try { await request(url, { method: 'POST', body: JSON.stringify(body) }); setNotice('Operación registrada.'); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function addInvitation(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await act('/losses/invitations', { description: String(f.get('description')), amount: Number(f.get('amount')), reason: String(f.get('reason')), notes: String(f.get('notes') || '') });
    setShowInvitation(false);
  }

  const max = Math.max(1, ...(data?.byReason.map(r => r.amount) ?? []));
  return <section className="finance-page">
    <div className="section-head"><div><h3>Pérdidas del negocio</h3><p>Mermas, roturas, invitaciones y descuadres valorados</p></div>
      {canManage && <button className="primary" onClick={() => setShowInvitation(true)}>＋ Invitación</button>}</div>
    {error && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    {notice && <div className="order-notice" onClick={() => setNotice('')}>✓ {notice}</div>}
    {data?.alert && <div className="loss-alert">⚠ Las pérdidas son el {data.percentOfSales} % de las ventas y superan el umbral del {data.thresholdPct} %.</div>}
    <div className="finance-period"><label>Desde<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>Hasta<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
      {canManage && <button className="secondary" onClick={() => { const value = window.prompt('Umbral de aviso (%)', String(data?.thresholdPct ?? 3)); if (value) void act('/loss/settings', { thresholdPct: Number(value) }); }}>Umbral {data?.thresholdPct ?? 3} %</button>}</div>
    {data && <>
      <div className="kpi-grid">
        <article><span>Pérdida total</span><strong>{euro(data.total)}</strong><small>{data.lines.length} movimientos</small></article>
        <article><span>Sobre ventas</span><strong>{data.percentOfSales === null ? '—' : `${data.percentOfSales} %`}</strong><small>ventas {euro(data.salesNet)}</small></article>
        <article><span>Motivo principal</span><strong>{data.byReason[0] ? REASON_LABEL[data.byReason[0].reason] || data.byReason[0].reason : '—'}</strong><small>{data.byReason[0] ? euro(data.byReason[0].amount) : 'sin pérdidas'}</small></article>
      </div>
      <div className="content-grid"><section><div className="section-head"><div><h3>Por motivo</h3><p>Comparación visual del periodo</p></div></div>
        <div className="loss-bars">{data.byReason.map(r => <div key={r.reason} className="loss-bar"><span>{REASON_LABEL[r.reason] || r.reason}</span><div className="bar"><i style={{ width: `${r.amount / max * 100}%` }} /></div><b>{euro(r.amount)}</b></div>)}{!data.byReason.length && <p className="finance-note">Sin pérdidas clasificadas.</p>}</div>
      </section><section><div className="section-head"><div><h3>Por producto y empleado</h3><p>Responsable de la operación</p></div></div>
        <div className="ledger-lines">{data.byProduct.slice(0, 8).map(p => <div key={p.product} className="ledger-line"><span>{p.product}</span><b>{euro(p.amount)}</b></div>)}
          {data.byEmployee.map(e => <div key={e.employee} className="ledger-line"><span>{e.employee}</span><small>empleado</small><b>{euro(e.amount)}</b></div>)}</div>
      </section></div>
      <div className="section-head"><div><h3>Detalle</h3><p>Cada línea conserva motivo, usuario y valor</p></div></div>
      <div className="ledger-lines">{data.lines.map(l => <div key={`${l.sourceType}-${l.id}`} className="ledger-line"><span>{l.date}</span><strong>{l.productName}</strong>
        <small>{REASON_LABEL[l.reason] || l.reason} · {l.employeeName || 'sin usuario'} · {l.sourceType}</small><b>{l.signedAmount !== undefined ? euro(l.signedAmount) : `−${euro(l.amount)}`}</b></div>)}</div>
    </>}
    {showInvitation && <div className="modal-backdrop"><form className="modal-card" onSubmit={addInvitation}>
      <div className="section-head"><div><h3>Registrar invitación</h3><p>No contabiliza como venta</p></div></div>
      <label>Descripción<input name="description" required placeholder="Cena de cortesía…" /></label>
      <div className="form-pair"><label>Importe<input name="amount" type="number" min="0.01" step="0.01" required /></label>
        <label>Motivo<select name="reason" defaultValue="invitation"><option value="invitation">Invitación</option><option value="staff_meal">Comida personal</option><option value="other">Otro</option></select></label></div>
      <label>Notas<input name="notes" /></label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setShowInvitation(false)}>Cancelar</button><button className="primary">Guardar pérdida</button></div>
    </form></div>}
  </section>;
}
