import { FormEvent, useEffect, useMemo, useState } from 'react';
import { DiningTable, OrderDetail, euro, request } from './lib';
import { PaymentModal } from './PaymentModal';

export const GRID_COLS = 8, GRID_ROWS = 5;
type TableState = 'free' | 'open' | 'sent' | 'partial';
const STATE_LABEL: Record<TableState, string> = { free: 'Libre', open: 'Comanda sin enviar', sent: 'En cocina / servida', partial: 'Cobro parcial' };

export function tableState(t: DiningTable): TableState {
  if (!t.activeOrder) return 'free';
  if (Number(t.activeOrder.paidTotal) > 0) return 'partial';
  return t.activeOrder.status === 'sent' ? 'sent' : 'open';
}
const minutesSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));

/** Plano de sala: cada mesa muestra en tiempo real el estado de su comanda. */
export function TablesView({ canEdit, onOpenInPos }: { canEdit: boolean; onOpenInPos: (table: { id: string; label: string }) => void }) {
  const [tables, setTables] = useState<DiningTable[]>([]), [zone, setZone] = useState(''), [selectedId, setSelectedId] = useState<string | null>(null), [detail, setDetail] = useState<OrderDetail | null>(null), [editMode, setEditMode] = useState(false), [paying, setPaying] = useState<string | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [draft, setDraft] = useState<{ posX: number; posY: number } | null>(null), [dragId, setDragId] = useState<string | null>(null), [pendingZone, setPendingZone] = useState<string | null>(null);

  async function load() { try { setTables(await request<DiningTable[]>('/tables')); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 15000); return () => clearInterval(timer); }, []);

  const zones = useMemo(() => { const list = [...new Set(tables.map(t => t.zone))]; if (pendingZone && !list.includes(pendingZone)) list.push(pendingZone); return list.length ? list : ['Salón']; }, [tables, pendingZone]);
  const currentZone = zones.includes(zone) ? zone : zones[0];
  const zoneTables = tables.filter(t => t.zone === currentZone);
  const selected = tables.find(t => t.id === selectedId) || null;
  const busy = tables.filter(t => t.activeOrder), openAmount = busy.reduce((s, t) => s + Number(t.activeOrder!.grossTotal) - Number(t.activeOrder!.paidTotal), 0);

  useEffect(() => {
    setDetail(null);
    if (!selected?.activeOrder) return;
    request<OrderDetail>(`/orders/${selected.activeOrder.id}`).then(setDetail).catch(e => setError(e.message));
  }, [selectedId, selected?.activeOrder?.id, selected?.activeOrder?.grossTotal, selected?.activeOrder?.paidTotal]);

  async function move(id: string, posX: number, posY: number) {
    if (tables.some(t => t.zone === currentZone && t.posX === posX && t.posY === posY)) return;
    setTables(current => current.map(t => t.id === id ? { ...t, posX, posY } : t));
    try { await request(`/tables/${id}`, { method: 'PATCH', body: JSON.stringify({ posX, posY }) }); } catch (e) { setError((e as Error).message); void load(); }
  }
  function clickCell(posX: number, posY: number) {
    if (!editMode) { setSelectedId(null); return; }
    if (selected && selected.zone === currentZone) { void move(selected.id, posX, posY); return; }
    setDraft({ posX, posY }); setSelectedId(null);
  }
  async function createTable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    try {
      const created = await request<DiningTable>('/tables', { method: 'POST', body: JSON.stringify({ label: String(f.get('label')), seats: Number(f.get('seats')), shape: String(f.get('shape')), zone: String(f.get('zone') || currentZone), posX: draft?.posX ?? 0, posY: draft?.posY ?? 0 }) });
      setDraft(null); await load(); setZone(created.zone); setSelectedId(created.id); setNotice(`${created.label} añadida al plano.`);
    } catch (err) { setError((err as Error).message); }
  }
  async function saveTable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!selected) return; const f = new FormData(e.currentTarget);
    try { await request(`/tables/${selected.id}`, { method: 'PATCH', body: JSON.stringify({ label: String(f.get('label')), seats: Number(f.get('seats')), shape: String(f.get('shape')), zone: String(f.get('zone')) }) }); await load(); setZone(String(f.get('zone'))); setNotice('Mesa actualizada.'); }
    catch (err) { setError((err as Error).message); }
  }
  async function removeTable() {
    if (!selected || !confirm(`¿Eliminar ${selected.label} del plano?`)) return;
    try { await request(`/tables/${selected.id}`, { method: 'DELETE' }); setSelectedId(null); await load(); setNotice('Mesa eliminada.'); } catch (err) { setError((err as Error).message); }
  }
  function nextFreeCell() { for (let y = 0; y < GRID_ROWS; y++) for (let x = 0; x < GRID_COLS; x++) if (!zoneTables.some(t => t.posX === x && t.posY === y)) return { posX: x, posY: y }; return { posX: 0, posY: 0 }; }

  const cells: { x: number; y: number; table?: DiningTable }[] = [];
  for (let y = 0; y < GRID_ROWS; y++) for (let x = 0; x < GRID_COLS; x++) cells.push({ x, y, table: zoneTables.find(t => t.posX === x && t.posY === y) });
  const offGrid = zoneTables.filter(t => t.posX >= GRID_COLS || t.posY >= GRID_ROWS);

  return <section className="tables-page">
    <div className="section-head"><div><h3>Mapa de mesas</h3><p>Toca una mesa para abrir su comanda, añadir productos o cobrar</p></div>
      <div className="tables-head-actions"><button className="secondary" onClick={() => void load()}>Actualizar ↻</button>{canEdit && <button className={editMode ? 'primary' : 'secondary'} onClick={() => { setEditMode(!editMode); setDraft(null); }}>{editMode ? 'Terminar edición' : '✎ Editar plano'}</button>}</div></div>
    {error && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    {notice && <div className="order-notice" onClick={() => setNotice('')}>✓ {notice}</div>}
    <div className="table-stats">
      <article><span>Mesas libres</span><strong>{tables.length - busy.length}</strong><small>de {tables.length}</small></article>
      <article><span>Ocupadas</span><strong>{busy.length}</strong><small>con comanda abierta</small></article>
      <article><span>Pendiente de cobro</span><strong>{euro(openAmount)}</strong><small>en sala</small></article>
    </div>
    <div className="zone-tabs">{zones.map(z => <button key={z} className={z === currentZone ? 'selected' : ''} onClick={() => { setZone(z); setSelectedId(null); setDraft(null); }}>{z}<span>{tables.filter(t => t.zone === z && t.activeOrder).length}/{tables.filter(t => t.zone === z).length}</span></button>)}
      {editMode && <button className="zone-add" onClick={() => { const name = prompt('Nombre de la nueva zona (p. ej. Reservado)')?.trim(); if (name) { setPendingZone(name); setZone(name); setSelectedId(null); setDraft({ posX: 0, posY: 0 }); setNotice(`Añade la primera mesa de «${name}».`); } }}>＋ Zona</button>}
    </div>
    <div className="legend">{(['free', 'open', 'sent', 'partial'] as TableState[]).map(s => <span key={s}><i className={`dot ${s}`} />{STATE_LABEL[s]}</span>)}</div>
    <div className="tables-layout">
      <div className={`floor ${editMode ? 'editing' : ''}`} style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0,1fr))` }}>
        {cells.map(({ x, y, table }) => table
          ? <button key={table.id} draggable={editMode} onDragStart={() => setDragId(table.id)} onDragEnd={() => setDragId(null)}
              className={`dining-table ${table.shape} ${tableState(table)} ${selectedId === table.id ? 'selected' : ''}`}
              onClick={() => { setSelectedId(table.id); setDraft(null); }} aria-label={`${table.label}: ${STATE_LABEL[tableState(table)]}`}>
              <strong>{table.label}</strong>
              {table.activeOrder ? <><span className="t-total">{euro(Number(table.activeOrder.grossTotal) - Number(table.activeOrder.paidTotal))}</span><small>{minutesSince(table.activeOrder.openedAt)} min · #{table.activeOrder.orderNumber}</small></> : <small>{table.seats} {table.seats === 1 ? 'plaza' : 'plazas'}</small>}
            </button>
          : <div key={`${x}-${y}`} className={`floor-cell ${draft && draft.posX === x && draft.posY === y ? 'draft' : ''}`} onClick={() => clickCell(x, y)}
              onDragOver={e => { if (editMode) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (dragId) void move(dragId, x, y); setDragId(null); }}>{editMode && <span>＋</span>}</div>)}
        {offGrid.map(t => <button key={t.id} className="dining-table offgrid" onClick={() => setSelectedId(t.id)}>{t.label}</button>)}
      </div>

      <aside className="table-panel">
        {draft && editMode ? <form onSubmit={createTable} className="table-form">
          <p className="eyebrow">NUEVA MESA</p><h3>Añadir mesa en {currentZone}</h3>
          <label>Nombre<input name="label" required autoFocus placeholder={`Mesa ${tables.length + 1}`} defaultValue={`${currentZone === 'Salón' ? 'Mesa' : currentZone} ${zoneTables.length + 1}`} /></label>
          <input type="hidden" name="zone" value={currentZone} />
          <label>Plazas<input name="seats" type="number" min="1" step="1" defaultValue={4} required /></label>
          <label>Forma<select name="shape" defaultValue="square"><option value="square">Cuadrada</option><option value="round">Redonda</option><option value="bar">Barra / taburete</option></select></label>
          <div className="modal-actions"><button type="button" className="secondary" onClick={() => setDraft(null)}>Cancelar</button><button className="primary">Añadir mesa</button></div>
        </form>
        : !selected ? <div className="empty">{editMode ? <>Arrastra una mesa para moverla, o toca una casilla vacía para crear una nueva.<br /><br /><button className="secondary" onClick={() => setDraft(nextFreeCell())}>＋ Añadir mesa</button></> : 'Selecciona una mesa del plano.'}</div>
        : editMode ? <form key={selected.id} onSubmit={saveTable} className="table-form">
          <p className="eyebrow">EDITAR MESA</p><h3>{selected.label}</h3>
          <p className="modal-description">Para moverla, arrástrala o toca una casilla vacía del plano.</p>
          <label>Nombre<input name="label" required defaultValue={selected.label} /></label>
          <label>Zona<input name="zone" required defaultValue={selected.zone} list="zones-list" /><datalist id="zones-list">{zones.map(z => <option key={z} value={z} />)}</datalist></label>
          <label>Plazas<input name="seats" type="number" min="1" step="1" defaultValue={selected.seats} required /></label>
          <label>Forma<select name="shape" defaultValue={selected.shape}><option value="square">Cuadrada</option><option value="round">Redonda</option><option value="bar">Barra / taburete</option></select></label>
          <div className="modal-actions"><button type="button" className="remove-button" onClick={() => void removeTable()}>Eliminar mesa</button><button className="primary">Guardar</button></div>
        </form>
        : <div className="table-detail">
          <p className="eyebrow">{selected.zone.toUpperCase()} · {selected.seats} PLAZAS</p>
          <h3>{selected.label}</h3>
          {canEdit&&selected.qrToken&&<button className="secondary wide-secondary" onClick={()=>{const url=`${window.location.origin}/?qr=${encodeURIComponent(selected.qrToken!)}`;void navigator.clipboard.writeText(url).then(()=>setNotice(`Enlace QR de ${selected.label} copiado.`)).catch(()=>setError(`Enlace QR: ${url}`))}}>Copiar enlace de pedido QR</button>}
          <span className={`state-pill ${tableState(selected)}`}>{STATE_LABEL[tableState(selected)]}</span>
          {!selected.activeOrder ? <>
            <p className="modal-description">Mesa libre. Abre una comanda y añade los productos desde la carta.</p>
            <button className="primary wide" onClick={() => onOpenInPos({ id: selected.id, label: selected.label })}>Abrir comanda <span>→</span></button>
          </> : <>
            <p className="modal-description">Comanda #{selected.activeOrder.orderNumber} · abierta hace {minutesSince(selected.activeOrder.openedAt)} min</p>
            <div className="pay-lines">{detail?.lines.map(l => <div key={l.id}><span>{Number(l.quantity)} × {l.productName}</span><strong>{euro(l.lineGross)}</strong></div>)}{detail && !detail.lines.length && <p className="finance-note">Todavía sin productos.</p>}{!detail && <p className="finance-note">Cargando comanda…</p>}</div>
            <div className="pay-summary"><div><span>Total</span><strong>{euro(selected.activeOrder.grossTotal)}</strong></div><div><span>Cobrado</span><strong>{euro(selected.activeOrder.paidTotal)}</strong></div><div className="pay-remaining"><span>Pendiente</span><strong>{euro(Number(selected.activeOrder.grossTotal) - Number(selected.activeOrder.paidTotal))}</strong></div></div>
            <button className="secondary wide-secondary" onClick={() => onOpenInPos({ id: selected.id, label: selected.label })}>＋ Añadir productos</button>
            <button className="primary wide" disabled={Number(selected.activeOrder.grossTotal) <= 0} onClick={() => setPaying(selected.activeOrder!.id)}>Cobrar mesa <span>{euro(Number(selected.activeOrder.grossTotal) - Number(selected.activeOrder.paidTotal))}</span></button>
          </>}
        </div>}
      </aside>
    </div>
    {paying && <PaymentModal orderId={paying} onClose={() => { setPaying(null); void load(); }} onPaid={closed => { void load(); if (closed) setNotice(`${selected?.label || 'Mesa'} cobrada y liberada.`); }} />}
  </section>;

}
