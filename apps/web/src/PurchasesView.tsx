import { FormEvent, useEffect, useState } from 'react';
import { DEMO, euro, request } from './lib';

type PurchaseLine = { id: string; description: string | null; ingredientName: string | null; quantity: number; unitPriceNet: number; vatRate: number; lineGross: number };
type Payment = { id: string; amount: number; method: string; account: string; reference: string | null; paidAt: string };
type Purchase = {
  id: string; invoiceNumber: string | null; invoiceDate: string; dueDate: string | null; status: string; paymentStatus: string;
  paidAmount: number; grossTotal: number; pendingAmount: number; vatDeductible: boolean; supplierName: string | null; lineCount: number;
};
type Detail = Purchase & { notes: string | null; lines: PurchaseLine[]; payments: Payment[] };
type Row = { id: string; name: string };
type DraftLine = { ingredientId: string; description: string; quantity: string; unitPriceNet: string; vatRate: string };

const STATUS: Record<string, string> = { draft: 'Borrador', received: 'Recibida', void: 'Anulada', pending: 'Pendiente', partial: 'Parcial', paid: 'Pagada' };

export function PurchasesView({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Purchase[]>([]), [totals, setTotals] = useState({ gross: 0, paid: 0, pending: 0 });
  const [suppliers, setSuppliers] = useState<Row[]>([]), [ingredients, setIngredients] = useState<Row[]>([]);
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [supplierId, setSupplierId] = useState(''), [status, setStatus] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [detail, setDetail] = useState<Detail | null>(null), [showForm, setShowForm] = useState(false);
  const [draftLines, setDraftLines] = useState<DraftLine[]>([{ ingredientId: '', description: '', quantity: '1', unitPriceNet: '', vatRate: '21' }]);

  async function load() {
    if (DEMO) { setRows([]); setTotals({ gross: 0, paid: 0, pending: 0 }); return; }
    try {
      const q = new URLSearchParams({ from, to, supplierId, status });
      const result = await request<{ lines: Purchase[]; totals: { gross: number; paid: number; pending: number } }>(`/purchases?${q}`);
      setRows(result.lines); setTotals(result.totals);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [from, to, supplierId, status]);
  useEffect(() => {
    if (DEMO || !canManage) return;
    void request<Row[]>('/suppliers').then(setSuppliers).catch(() => {});
    void request<Row[]>('/inventory/ingredients').then(setIngredients).catch(() => {});
  }, [canManage]);

  async function open(id: string) {
    if (DEMO) return;
    try { setDetail(await request<Detail>(`/purchases/${id}`)); } catch (e) { setError((e as Error).message); }
  }
  async function receive(id: string) {
    try { await request(`/purchases/${id}/receive`, { method: 'POST' }); setNotice('Factura recibida: stock y cuentas actualizados.'); setDetail(null); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function pay() {
    if (!detail) return;
    const amount = window.prompt(`Importe a pagar (pendiente ${euro(detail.pendingAmount)})`);
    if (!amount || !Number(amount)) return;
    try {
      await request(`/purchases/${detail.id}/payments`, { method: 'POST', body: JSON.stringify({ amount: Number(amount) }) });
      setNotice('Pago registrado.'); await open(detail.id); await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const lines = draftLines.map(l => l.ingredientId
      ? { ingredientId: l.ingredientId, quantity: Number(l.quantity), unitPriceNet: l.description ? Number(l.unitPriceNet) : undefined, vatRate: Number(l.vatRate) }
      : { description: l.description, quantity: Number(l.quantity), unitPriceNet: Number(l.unitPriceNet), vatRate: Number(l.vatRate) });
    try {
      await request('/purchases', { method: 'POST', body: JSON.stringify({
        supplierId: String(f.get('supplierId') || '') || undefined, invoiceNumber: String(f.get('invoiceNumber') || ''),
        invoiceDate: String(f.get('invoiceDate')), dueDate: String(f.get('dueDate') || '') || undefined,
        paymentMethod: String(f.get('paymentMethod')), vatDeductible: f.get('vatDeductible') === 'on', notes: String(f.get('notes') || ''), lines
      }) });
      setShowForm(false); setNotice('Factura guardada como borrador.'); await load();
    } catch (err) { setError((err as Error).message); }
  }

  return <section className="finance-page">
    <div className="section-head"><div><h3>Compras a proveedores</h3><p>Facturas, recepción, pago y gasto contable</p></div>
      {canManage && !DEMO && <button className="primary" onClick={() => setShowForm(true)}>＋ Nueva factura</button>}</div>
    {error && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    {notice && <div className="order-notice" onClick={() => setNotice('')}>✓ {notice}</div>}
    <div className="finance-period"><label>Desde<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>Hasta<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
      <label>Proveedor<select value={supplierId} onChange={e => setSupplierId(e.target.value)}><option value="">Todos</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Estado<select value={status} onChange={e => setStatus(e.target.value)}><option value="">Todos</option><option value="draft">Borrador</option><option value="received">Recibida</option><option value="pending">Pendiente de pago</option><option value="partial">Pago parcial</option><option value="paid">Pagada</option></select></label></div>
    <div className="kpi-grid">
      <article><span>Total facturado</span><strong>{euro(totals.gross)}</strong><small>{rows.length} facturas</small></article>
      <article><span>Pagado</span><strong>{euro(totals.paid)}</strong><small>tesorería</small></article>
      <article><span>Pendiente</span><strong>{euro(totals.pending)}</strong><small>compromisos de pago</small></article>
    </div>
    <div className="content-grid">
      <section><div className="section-head"><div><h3>Facturas</h3><p>La fecha del filtro es la fecha de factura</p></div></div>
        <div className="ledger-lines">{rows.map(p => <button key={p.id} className={`ledger-line purchase-row ${detail?.id === p.id ? 'selected' : ''}`} onClick={() => void open(p.id)}>
          <span>{p.invoiceDate}</span><strong>{p.invoiceNumber || 'Sin número'} <small>{p.supplierName || 'Sin proveedor'}</small></strong>
          <small>{STATUS[p.paymentStatus] || STATUS[p.status]} · {p.lineCount} líneas</small>
          <b>{euro(p.grossTotal)}</b><small className={p.pendingAmount > 0 ? 'pending-amount' : ''}>Pend. {euro(p.pendingAmount)}</small>
        </button>)}{!rows.length && <p className="finance-note">No hay facturas en este periodo.</p>}</div>
      </section>
      {detail && <aside><div className="section-head"><div><h3>{detail.invoiceNumber || 'Factura'}</h3><p>{detail.supplierName || 'Sin proveedor'} · {detail.invoiceDate}</p></div><button className="secondary" onClick={() => setDetail(null)}>×</button></div>
        <p className="finance-note">Estado: {STATUS[detail.status]} · Pago: {STATUS[detail.paymentStatus]} · IVA {detail.vatDeductible ? 'deducible' : 'no deducible'}</p>
        {detail.notes && <p className="finance-note">{detail.notes}</p>}
        <div className="ledger-lines">{detail.lines.map(l => <div key={l.id} className="ledger-line"><span>{l.ingredientName || l.description}</span><small>{l.quantity} × {euro(l.unitPriceNet)} · IVA {l.vatRate}%</small><b>{euro(l.lineGross)}</b></div>)}</div>
        <p className="finance-note">Total {euro(detail.grossTotal)} · Pagado {euro(detail.paidAmount)} · Pendiente {euro(detail.pendingAmount)}</p>
        {!!detail.payments.length && <div className="ledger-lines">{detail.payments.map(p => <div key={p.id} className="ledger-line"><span>{p.paidAt.slice(0, 10)}</span><small>{p.account} · {p.method}</small><b>{euro(p.amount)}</b></div>)}</div>}
        {canManage && !DEMO && detail.status === 'draft' && <button className="primary wide" onClick={() => void receive(detail.id)}>Recibir mercancía y contabilizar</button>}
        {canManage && !DEMO && detail.status === 'received' && detail.pendingAmount > 0 && <button className="primary wide" onClick={() => void pay()}>Registrar pago</button>}
      </aside>}
    </div>
    {showForm && <div className="modal-backdrop"><form className="modal-card" onSubmit={create}>
      <div className="section-head"><div><h3>Nueva factura</h3><p>Las líneas libres no afectan al stock</p></div></div>
      <div className="form-pair"><label>Proveedor<select name="supplierId"><option value="">Sin proveedor</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Número de factura<input name="invoiceNumber" required placeholder="F-2026-001" /></label></div>
      <div className="form-pair"><label>Fecha de factura<input name="invoiceDate" type="date" required defaultValue={new Date().toLocaleDateString('en-CA')} /></label>
        <label>Vencimiento<input name="dueDate" type="date" /></label></div>
      <div className="form-pair"><label>Forma de pago<select name="paymentMethod"><option value="cash">Efectivo</option><option value="card">Tarjeta</option><option value="transfer">Transferencia</option></select></label>
        <label className="checkbox-line"><input type="checkbox" name="vatDeductible" defaultChecked /> IVA deducible</label></div>
      <label>Observaciones<input name="notes" /></label>
      <div className="purchase-lines">{draftLines.map((l, i) => <div key={i} className="purchase-line-edit">
        <select aria-label="Ingrediente" value={l.ingredientId} onChange={e => setDraftLines(current => current.map((x, j) => j === i ? { ...x, ingredientId: e.target.value } : x))}>
          <option value="">Línea libre…</option>{ingredients.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <input aria-label="Descripción" placeholder="Menaje, portes…" value={l.description} onChange={e => setDraftLines(current => current.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
        <input aria-label="Cantidad" type="number" min="0.001" step="0.001" value={l.quantity} onChange={e => setDraftLines(current => current.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} />
        <input aria-label="Precio neto" type="number" min="0" step="0.01" placeholder="Precio" value={l.unitPriceNet} onChange={e => setDraftLines(current => current.map((x, j) => j === i ? { ...x, unitPriceNet: e.target.value } : x))} />
        <input aria-label="IVA %" type="number" min="0" step="0.01" value={l.vatRate} onChange={e => setDraftLines(current => current.map((x, j) => j === i ? { ...x, vatRate: e.target.value } : x))} />
        <button type="button" className="remove-button" onClick={() => setDraftLines(current => current.filter((_, j) => j !== i))}>×</button>
      </div>)}</div>
      <button type="button" className="secondary" onClick={() => setDraftLines(current => [...current, { ingredientId: '', description: '', quantity: '1', unitPriceNet: '', vatRate: '21' }])}>＋ Añadir línea</button>
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setShowForm(false)}>Cancelar</button><button className="primary">Guardar borrador</button></div>
    </form></div>}
  </section>;
}
