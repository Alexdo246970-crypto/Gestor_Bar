import { useEffect, useState } from 'react';
import { OrderDetail, euro, request } from './lib';

type Method = 'card' | 'cash';
const QUICK_CASH = [5, 10, 20, 50];

/** Cobro de una comanda: tarjeta (datáfono TPV) o efectivo, con pagos parciales y cálculo del cambio. */
export function PaymentModal({ orderId, onClose, onPaid }: { orderId: string; onClose: () => void; onPaid: (closed: boolean) => void }) {
  const [order, setOrder] = useState<OrderDetail | null>(null), [method, setMethod] = useState<Method>('card'), [amount, setAmount] = useState(''), [tendered, setTendered] = useState(''), [reference, setReference] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false), [done, setDone] = useState<{ closed: boolean; change: number | null; method: Method; amount: number } | null>(null);

  async function load() {
    try { const detail = await request<OrderDetail>(`/orders/${orderId}`); setOrder(detail); const remaining = Math.max(0, Number(detail.grossTotal) - Number(detail.paidTotal)); setAmount(remaining.toFixed(2)); setTendered(''); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [orderId]);

  const total = Number(order?.grossTotal || 0), paidSoFar = Number(order?.paidTotal || 0), remaining = Math.max(0, Math.round((total - paidSoFar) * 100) / 100);
  const amountValue = Number(amount), tenderedValue = tendered === '' ? amountValue : Number(tendered);
  const change = method === 'cash' && Number.isFinite(tenderedValue) ? tenderedValue - amountValue : 0;
  const invalid = !order || !(amountValue > 0) || amountValue > remaining + 0.001 || (method === 'cash' && !(tenderedValue + 0.001 >= amountValue));

  async function pay() {
    if (invalid || saving) return;
    setSaving(true); setError('');
    try {
      const result = await request<{ closed: boolean; change: number | null }>(`/orders/${orderId}/payments`, { method: 'POST', body: JSON.stringify(method === 'cash' ? { method, amount: amountValue, cashTendered: tenderedValue } : { method, amount: amountValue, cardReference: reference || undefined }) });
      setDone({ closed: result.closed, change: result.change, method, amount: amountValue }); setReference('');
      onPaid(result.closed);
      await load();
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }

  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="package-modal payment-modal" role="dialog" aria-label="Cobrar comanda">
      <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">×</button>
      <p className="eyebrow">COBRAR COMANDA</p>
      <h3>{order ? `${order.tableLabel || 'Mostrador'} · #${order.orderNumber}` : 'Cargando…'}</h3>
      {order && <>
        <div className="pay-lines">{order.lines.map(l => <div key={l.id}><span>{Number(l.quantity)} × {l.productName}</span><strong>{euro(l.lineGross)}</strong></div>)}</div>
        <div className="pay-summary"><div><span>Total</span><strong>{euro(total)}</strong></div><div><span>Cobrado</span><strong>{euro(paidSoFar)}</strong></div><div className="pay-remaining"><span>Pendiente</span><strong>{euro(remaining)}</strong></div></div>
        {order.payments && order.payments.length > 0 && <div className="pay-history">{order.payments.map(p => <div key={p.id}><span>{p.method === 'card' ? '💳 Tarjeta (TPV)' : '💶 Efectivo'}{p.cardReference ? ` · Ref. ${p.cardReference}` : ''}{p.changeGiven ? ` · cambio ${euro(p.changeGiven)}` : ''}</span><strong>{euro(p.amount)}</strong></div>)}</div>}
      </>}
      {done && <div className={`pay-result ${done.closed ? 'closed' : ''}`}>
        ✓ Cobrados {euro(done.amount)} {done.method === 'card' ? 'con tarjeta' : 'en efectivo'}
        {done.method === 'cash' && done.change != null && done.change > 0 && <strong>Cambio a devolver: {euro(done.change)}</strong>}
        {done.closed && <small>Comanda cerrada{order?.tableId ? ' y mesa liberada' : ''}.</small>}
      </div>}
      {order && remaining > 0 && <>
        <div className="pay-methods" role="radiogroup" aria-label="Forma de pago">
          <button type="button" role="radio" aria-checked={method === 'card'} className={method === 'card' ? 'selected' : ''} onClick={() => setMethod('card')}><span>💳</span>Tarjeta<small>Datáfono TPV</small></button>
          <button type="button" role="radio" aria-checked={method === 'cash'} className={method === 'cash' ? 'selected' : ''} onClick={() => setMethod('cash')}><span>💶</span>Efectivo<small>Metálico</small></button>
        </div>
        <label>Importe a cobrar (€)<input type="number" min="0.01" step="0.01" max={remaining} value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <div className="quick-row"><button type="button" onClick={() => setAmount(remaining.toFixed(2))}>Todo</button><button type="button" onClick={() => setAmount((Math.round(remaining / 2 * 100) / 100).toFixed(2))}>Mitad</button><button type="button" onClick={() => setAmount((Math.round(remaining / 3 * 100) / 100).toFixed(2))}>1/3</button></div>
        {method === 'cash' ? <>
          <label>Efectivo entregado (€)<input type="number" min="0" step="0.01" placeholder={amountValue > 0 ? amountValue.toFixed(2) : ''} value={tendered} onChange={e => setTendered(e.target.value)} /></label>
          <div className="quick-row">{QUICK_CASH.map(v => <button type="button" key={v} onClick={() => setTendered(String(v))}>{v} €</button>)}<button type="button" onClick={() => setTendered('')}>Exacto</button></div>
          <div className={`change-box ${change < -0.001 ? 'short' : ''}`}><span>{change < -0.001 ? 'Falta' : 'Cambio'}</span><strong>{euro(Math.abs(change))}</strong></div>
        </> : <>
          <p className="modal-description">Introduce el importe en el datáfono, espera la aprobación y confirma aquí.</p>
          <label>Referencia de la operación TPV (opcional)<input value={reference} maxLength={40} onChange={e => setReference(e.target.value)} placeholder="Ej. autorización 123456" /></label>
        </>}
        {error && <p className="error">{error}</p>}
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancelar</button><button type="button" className="primary" disabled={invalid || saving} onClick={() => void pay()}>{saving ? 'Cobrando…' : method === 'card' ? `Cobrar ${euro(amountValue)} con tarjeta` : `Cobrar ${euro(amountValue)} en efectivo`}</button></div>
      </>}
      {order && remaining <= 0 && <div className="modal-actions"><button type="button" className="primary" onClick={onClose}>Hecho</button></div>}
      {!order && error && <p className="error">{error}</p>}
    </div>
  </div>;
}
