import { FormEvent, useEffect, useMemo, useState } from 'react';
import { API, DEMO, DiningTable, OrderDetail, euro, request } from './lib';
import { PaymentModal } from './PaymentModal';

export const GRID_COLS = 8, GRID_ROWS = 5;
type TableState = 'free' | 'open' | 'sent' | 'partial';
const STATE_LABEL: Record<TableState, string> = { free: 'Libre', open: 'Comanda sin enviar', sent: 'En cocina / servida', partial: 'Cobro parcial' };
type Room = { id: string; name: string; widthCm: number; heightCm: number; sortOrder: number; active: boolean; tableCount: number; busyCount: number };

export function tableState(t: DiningTable): TableState {
  if (!t.activeOrder) return 'free';
  if (Number(t.activeOrder.paidTotal) > 0) return 'partial';
  return t.activeOrder.status === 'sent' ? 'sent' : 'open';
}
const minutesSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const ROUND: [number, number][] = [[70, 3], [90, 4], [120, 8], [150, 10]];
const SQUARE: [number, number][] = [[70, 2], [80, 4], [90, 4], [100, 6], [120, 8]];
const SIDE_LABEL: Record<string, string> = { long1: 'Largo 1', long2: 'Largo 2', short1: 'Corto 1', short2: 'Corto 2' };
const RECT_SIDES = Object.keys(SIDE_LABEL);
const closest = (table: [number, number][], value: number) => table.reduce((best, item) => Math.abs(item[0] - value) < Math.abs(best[0] - value) ? item : best)[1];
const roundRecommended = (d: number) => closest(ROUND, d);
const squareRecommended = (s: number) => closest(SQUARE, s);
const rectRecommended = (width: number, sides: string[]) => {
  if (!sides.length) return 0;
  const longs = sides.filter(s => s.startsWith('long')).length;
  return Math.min(20, Math.max(1, Math.floor(width / 60) * longs + (sides.length - longs)));
};
const spanX = (t: DiningTable) => t.spanX || 1, spanY = (t: DiningTable) => t.spanY || 1;
/** Escala real del plano: 1 cm = 2 px al 100 %, cada casilla representa 40 cm. */
const CM_PER_CELL = 40, PX_PER_CM = 2;
const cellsX = (t: DiningTable) => Math.max(1, Math.round((t.widthCm ?? 80) / CM_PER_CELL), spanX(t));
const cellsY = (t: DiningTable) => Math.max(1, Math.round((t.heightCm ?? 80) / CM_PER_CELL), spanY(t));
const covers = (t: DiningTable, x: number, y: number) => x >= t.posX && x < t.posX + cellsX(t) && y >= t.posY && y < t.posY + cellsY(t);
/** Dos mesas se pueden unir si están pegadas y alineadas, de modo que juntas formen un rectángulo. */
export function canJoin(a: DiningTable, b: DiningTable) {
  if (a.id === b.id || a.zone !== b.zone || (a.activeOrder && b.activeOrder)) return false;
  const horizontal = a.posY === b.posY && cellsY(a) === cellsY(b) && (a.posX + cellsX(a) === b.posX || b.posX + cellsX(b) === a.posX);
  const vertical = a.posX === b.posX && cellsX(a) === cellsX(b) && (a.posY + cellsY(a) === b.posY || b.posY + cellsY(b) === a.posY);
  return horizontal || vertical;
}

/** Plano de sala: cada mesa muestra en tiempo real el estado de su comanda. */
export function TablesView({ canEdit, onOpenInPos }: { canEdit: boolean; onOpenInPos: (table: { id: string; label: string }) => void }) {
  const [tables, setTables] = useState<DiningTable[]>([]), [rooms, setRooms] = useState<Room[]>([]), [zone, setZone] = useState(''), [selectedId, setSelectedId] = useState<string | null>(null), [detail, setDetail] = useState<OrderDetail | null>(null), [editMode, setEditMode] = useState(false), [paying, setPaying] = useState<string | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [draft, setDraft] = useState<{ posX: number; posY: number } | null>(null), [dragId, setDragId] = useState<string | null>(null), [pendingZone, setPendingZone] = useState<string | null>(null), [zoom, setZoom] = useState(1);
  const [qrSettings,setQrSettings]=useState({approvalRequired:false,maxOrderLines:20,cooldownSeconds:120}),[showQrSettings,setShowQrSettings]=useState(false);

  async function load() {
    try {
      const [list, roomList] = await Promise.all([request<DiningTable[]>('/tables'), DEMO ? Promise.resolve([] as Room[]) : request<Room[]>('/rooms')]);
      setTables(list); setRooms(roomList);
    } catch (e) { setError((e as Error).message); }
  }
  async function addRoom() {
    const name = prompt('Nombre de la nueva sala')?.trim(); if (!name) return;
    try { const room = await request<Room>('/rooms', { method: 'POST', body: JSON.stringify({ name }) }); await load(); setZone(room.name); setNotice(`Sala «${room.name}» creada.`); }
    catch (e) { setError((e as Error).message); }
  }
  async function renameRoom() {
    const room = rooms.find(r => r.name === currentZone); if (!room) return;
    const name = prompt('Nuevo nombre de la sala', room.name)?.trim(); if (!name || name === room.name) return;
    try { await request(`/rooms/${room.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }); await load(); setZone(name); setNotice('Sala renombrada; las mesas y comandas se han conservado.'); }
    catch (e) { setError((e as Error).message); }
  }
  async function archiveRoom() {
    const room = rooms.find(r => r.name === currentZone); if (!room) return;
    if (!confirm(`¿Archivar «${room.name}»? Las mesas y el histórico se conservan.`)) return;
    try { await request(`/rooms/${room.id}`, { method: 'DELETE' }); await load(); setZone(''); setNotice('Sala archivada.'); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if(canEdit) request<typeof qrSettings>('/tables/qr-settings').then(setQrSettings).catch(e=>setError((e as Error).message)); }, [canEdit]);
  async function saveQrSettings(e:FormEvent<HTMLFormElement>){e.preventDefault();const data=new FormData(e.currentTarget),next={approvalRequired:data.get('approvalRequired')==='on',maxOrderLines:Number(data.get('maxOrderLines')),cooldownSeconds:Number(data.get('cooldownSeconds'))};try{setQrSettings(await request('/tables/qr-settings',{method:'PATCH',body:JSON.stringify(next)}));setShowQrSettings(false);setNotice('Ajustes de pedidos QR guardados.')}catch(err){setError((err as Error).message)}}
  async function rotateQrToken(){if(!selected||!confirm(`El QR anterior de ${selected.label} dejará de funcionar. ¿Regenerarlo?`))return;try{const updated=await request<{qrToken:string}>(`/tables/${selected.id}/qr-token`,{method:'POST'});setTables(current=>current.map(t=>t.id===selected.id?{...t,qrToken:updated.qrToken}:t));setNotice(`QR de ${selected.label} regenerado; el enlace anterior ya no sirve.`)}catch(err){setError((err as Error).message)}}
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 30000);
    const events = new EventSource(`${API}/tables/events`, { withCredentials: true });
    events.onmessage = () => void load();
    return () => { clearInterval(timer); events.close(); };
  }, []);

  const zones = useMemo(() => { const list = rooms.length ? rooms.map(r => r.name) : [...new Set(tables.map(t => t.zone))]; if (pendingZone && !list.includes(pendingZone)) list.push(pendingZone); return list.length ? list : ['Salón']; }, [tables, rooms, pendingZone]);
  const currentZone = zones.includes(zone) ? zone : zones[0];
  const zoneTables = tables.filter(t => t.zone === currentZone);
  const selected = tables.find(t => t.id === selectedId) || null;
  const [draftSeats, setDraftSeats] = useState(4), [draftDiameter, setDraftDiameter] = useState(90), [draftSide, setDraftSide] = useState(80);
  const [draftWidth, setDraftWidth] = useState(120), [draftHeight, setDraftHeight] = useState(80), [draftSides, setDraftSides] = useState<string[]>(['long1', 'long2']);
  const [editSeats, setEditSeats] = useState(4), [editDiameter, setEditDiameter] = useState(90), [editSide, setEditSide] = useState(80);
  const [editWidth, setEditWidth] = useState(120), [editHeight, setEditHeight] = useState(80), [editSides, setEditSides] = useState<string[]>(['long1', 'long2']);
  useEffect(() => {
    setEditSeats(selected?.seats ?? 4);
    setEditDiameter(Number(selected?.diameterCm) || 90);
    setEditSide(Number(selected?.widthCm) || 80);
    setEditWidth(Number(selected?.widthCm) || 120);
    setEditHeight(Number(selected?.heightCm) || 80);
    setEditSides(selected?.sidesUsed?.length ? selected.sidesUsed : ['long1', 'long2']);
  }, [selected?.id]);
  const toggleSide = (side: string, current: string[], set: (v: string[]) => void, width: number, setSeats: (v: number) => void) => {
    const next = current.includes(side) ? current.filter(s => s !== side) : [...current, side];
    set(next); setSeats(rectRecommended(width, next));
  };
  const busy = tables.filter(t => t.activeOrder), openAmount = busy.reduce((s, t) => s + Number(t.activeOrder!.grossTotal) - Number(t.activeOrder!.paidTotal), 0);

  useEffect(() => {
    setDetail(null);
    if (!selected?.activeOrder) return;
    request<OrderDetail>(`/orders/${selected.activeOrder.id}`).then(setDetail).catch(e => setError(e.message));
  }, [selectedId, selected?.activeOrder?.id, selected?.activeOrder?.grossTotal, selected?.activeOrder?.paidTotal]);

  async function move(id: string, posX: number, posY: number) {
    const t = tables.find(x => x.id === id); if (!t) return;
    const w = cellsX(t), h = cellsY(t);
    if (posX + w > GRID_COLS || posY + h > GRID_ROWS) { setError('La mesa no cabe en esa posición del plano.'); return; }
    if (zoneTables.some(o => o.id !== id && o.posX < posX + w && posX < o.posX + cellsX(o) && o.posY < posY + h && posY < o.posY + cellsY(o))) { setError('Hay otra mesa en ese hueco.'); return; }
    setTables(current => current.map(x => x.id === id ? { ...x, posX, posY } : x));
    try { await request(`/tables/${id}`, { method: 'PATCH', body: JSON.stringify({ posX, posY }) }); } catch (e) { setError((e as Error).message); void load(); }
  }
  function clickCell(posX: number, posY: number) {
    if (!editMode) { setSelectedId(null); return; }
    if (selected && selected.zone === currentZone) { void move(selected.id, posX, posY); return; }
    setDraft({ posX, posY }); setSelectedId(null);
  }
  async function createTable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const shape = String(f.get('shape'));
    try {
      const created = await request<DiningTable>('/tables', { method: 'POST', body: JSON.stringify({
        label: String(f.get('label')), seats: Number(f.get('seats')), shape,
        diameterCm: shape === 'round' ? Number(f.get('diameterCm')) : undefined,
        widthCm: shape === 'square' ? Number(f.get('widthCm')) : (shape === 'rect' ? draftWidth : undefined),
        heightCm: shape === 'rect' ? draftHeight : undefined,
        sidesUsed: shape === 'rect' ? draftSides : undefined,
        zone: String(f.get('zone') || currentZone), posX: draft?.posX ?? 0, posY: draft?.posY ?? 0 }) });
      setDraft(null); await load(); setZone(created.zone); setSelectedId(created.id); setNotice(`${created.label} añadida al plano.`);
    } catch (err) { setError((err as Error).message); }
  }
  async function saveTable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!selected) return; const f = new FormData(e.currentTarget);
    const shape = f.get('shape') ? String(f.get('shape')) : undefined;
    try { await request(`/tables/${selected.id}`, { method: 'PATCH', body: JSON.stringify({
      label: String(f.get('label')), seats: Number(f.get('seats')), shape,
      diameterCm: shape === 'round' ? Number(f.get('diameterCm')) : undefined,
      widthCm: shape === 'square' ? Number(f.get('widthCm')) : (shape === 'rect' ? editWidth : undefined),
      heightCm: shape === 'rect' ? editHeight : undefined,
      sidesUsed: shape === 'rect' ? editSides : undefined,
      zone: String(f.get('zone')) }) }); await load(); setZone(String(f.get('zone'))); setNotice('Mesa actualizada.'); }
    catch (err) { setError((err as Error).message); }
  }
  async function joinTables(target: DiningTable, other: DiningTable) {
    if (!confirm(`¿Unir ${target.label} y ${other.label} en una mesa rectangular?`)) return;
    try { const joined = await request<DiningTable>(`/tables/${target.id}/join`, { method: 'POST', body: JSON.stringify({ withId: other.id }) }); await load(); setSelectedId(joined.id); setNotice(`Mesas unidas: ${joined.label} (${joined.seats} plazas).`); }
    catch (err) { setError((err as Error).message); }
  }
  async function splitTable() {
    if (!selected) return;
    try { const t = await request<DiningTable>(`/tables/${selected.id}/split`, { method: 'POST' }); await load(); setSelectedId(t.id); setNotice('Mesas separadas.'); }
    catch (err) { setError((err as Error).message); }
  }
  async function removeTable() {
    if (!selected || !confirm(`¿Eliminar ${selected.label} del plano?`)) return;
    try { await request(`/tables/${selected.id}`, { method: 'DELETE' }); setSelectedId(null); await load(); setNotice('Mesa eliminada.'); } catch (err) { setError((err as Error).message); }
  }
  function nextFreeCell() { for (let y = 0; y < GRID_ROWS; y++) for (let x = 0; x < GRID_COLS; x++) if (!zoneTables.some(t => covers(t, x, y))) return { posX: x, posY: y }; return { posX: 0, posY: 0 }; }

  // Las mesas unidas ocupan varias casillas: se dibujan una vez en su esquina.
  const cells: { x: number; y: number; table?: DiningTable }[] = [];
  for (let y = 0; y < GRID_ROWS; y++) for (let x = 0; x < GRID_COLS; x++) {
    const table = zoneTables.find(t => covers(t, x, y));
    if (!table || (table.posX === x && table.posY === y)) cells.push({ x, y, table });
  }
  const dragged = dragId ? tables.find(t => t.id === dragId) : undefined;
  const joinable = selected && editMode ? zoneTables.filter(t => canJoin(selected, t)) : [];
  const offGrid = zoneTables.filter(t => t.posX >= GRID_COLS || t.posY >= GRID_ROWS);

  return <section className="tables-page">
    <div className="section-head"><div><h3>Mapa de mesas</h3><p>Toca una mesa para abrir su comanda, añadir productos o cobrar</p></div>
      <div className="tables-head-actions"><button className="secondary" onClick={() => void load()}>Actualizar ↻</button><button className="secondary" onClick={() => setZoom(z => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))} aria-label="Reducir zoom">−</button><span className="zoom-label">{Math.round(zoom * 100)} %</span><button className="secondary" onClick={() => setZoom(z => Math.min(3, Math.round((z + 0.25) * 100) / 100))} aria-label="Aumentar zoom">＋</button><button className="secondary" onClick={() => setZoom(1)}>Ajustar</button>{canEdit && <button className="secondary" onClick={()=>setShowQrSettings(v=>!v)}>Ajustes QR</button>}{canEdit && <button className={editMode ? 'primary' : 'secondary'} onClick={() => { setEditMode(!editMode); setDraft(null); }}>{editMode ? 'Terminar edición' : '✎ Editar plano'}</button>}</div></div>
    {error && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    {notice && <div className="order-notice" onClick={() => setNotice('')}>✓ {notice}</div>}
    {showQrSettings&&canEdit&&<form className="table-form qr-settings-form" onSubmit={saveQrSettings}><p className="eyebrow">PEDIDOS QR</p><h3>Control de pedidos</h3><label className="checkbox-row"><input type="checkbox" name="approvalRequired" defaultChecked={qrSettings.approvalRequired}/> Requerir aprobación del personal antes de enviar a cocina</label><div className="form-pair"><label>Máximo de líneas (1–20)<input name="maxOrderLines" type="number" min="1" max="20" defaultValue={qrSettings.maxOrderLines} required/></label><label>Espera entre pedidos (segundos)<input name="cooldownSeconds" type="number" min="0" max="3600" defaultValue={qrSettings.cooldownSeconds} required/></label></div><div className="modal-actions"><button type="button" className="secondary" onClick={()=>setShowQrSettings(false)}>Cancelar</button><button className="primary">Guardar ajustes</button></div></form>}
    <div className="table-stats">
      <article><span>Mesas libres</span><strong>{tables.length - busy.length}</strong><small>de {tables.length}</small></article>
      <article><span>Ocupadas</span><strong>{busy.length}</strong><small>con comanda abierta</small></article>
      <article><span>Pendiente de cobro</span><strong>{euro(openAmount)}</strong><small>en sala</small></article>
    </div>
    <div className="zone-tabs">{zones.map(z => <button key={z} className={z === currentZone ? 'selected' : ''} onClick={() => { setZone(z); setSelectedId(null); setDraft(null); }}>{z}<span>{tables.filter(t => t.zone === z && t.activeOrder).length}/{tables.filter(t => t.zone === z).length}</span></button>)}
      {editMode && !DEMO && <button className="zone-add" onClick={() => void addRoom()}>＋ Sala</button>}
      {editMode && !DEMO && rooms.some(r => r.name === currentZone) && <button className="zone-add" onClick={() => void renameRoom()}>✎ Renombrar sala</button>}
      {editMode && !DEMO && rooms.some(r => r.name === currentZone) && <button className="zone-add" onClick={() => void archiveRoom()}>Archivar sala</button>}
    </div>
    <div className="legend">{(['free', 'open', 'sent', 'partial'] as TableState[]).map(st => <span key={st}><i className={`dot ${st}`} />{STATE_LABEL[st]} <b>{tables.filter(t => t.zone === currentZone && tableState(t) === st).length}</b></span>)}</div>
    <div className="tables-layout">
      <div className="floor-scroll"><div className={`floor ${editMode ? 'editing' : ''}`} style={{ gridTemplateColumns: `repeat(${GRID_COLS}, ${CM_PER_CELL * PX_PER_CM * zoom}px)`, gridTemplateRows: `repeat(${GRID_ROWS}, ${CM_PER_CELL * PX_PER_CM * zoom}px)` }}>
        {cells.map(({ x, y, table }) => table
          ? <button key={table.id} draggable={editMode} onDragStart={() => setDragId(table.id)} onDragEnd={() => setDragId(null)}
              style={{ gridColumn: `${table.posX + 1} / span ${cellsX(table)}`, gridRow: `${table.posY + 1} / span ${cellsY(table)}` }}
              onDragOver={e => { if (editMode && dragged && canJoin(dragged, table)) e.preventDefault(); }}
              onDrop={e => { e.preventDefault(); if (dragged && canJoin(dragged, table)) void joinTables(table, dragged); setDragId(null); }}
              className={`dining-table ${table.shape} ${tableState(table)} ${selectedId === table.id ? 'selected' : ''} ${dragged && canJoin(dragged, table) ? 'join-target' : ''}`}
              onClick={() => { setSelectedId(table.id); setDraft(null); }} aria-label={`${table.label}: ${STATE_LABEL[tableState(table)]}`}>
              <strong>{table.label}</strong>
              {table.activeOrder ? <><span className="t-total">{euro(Number(table.activeOrder.grossTotal) - Number(table.activeOrder.paidTotal))}</span><small>{minutesSince(table.activeOrder.openedAt)} min · #{table.activeOrder.orderNumber}</small></> : <small>{table.seats} {table.seats === 1 ? 'plaza' : 'plazas'}</small>}
            </button>
          : <div key={`${x}-${y}`} style={{ gridColumn: x + 1, gridRow: y + 1 }} className={`floor-cell ${draft && draft.posX === x && draft.posY === y ? 'draft' : ''}`} onClick={() => clickCell(x, y)}
              onDragOver={e => { if (editMode) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (dragId) void move(dragId, x, y); setDragId(null); }}>{editMode && <span>＋</span>}</div>)}
        {offGrid.map(t => <button key={t.id} className="dining-table offgrid" onClick={() => setSelectedId(t.id)}>{t.label}</button>)}
      </div></div>
      <div className="mobile-table-list">{zoneTables.map(t => <button key={t.id} className={`mobile-table ${tableState(t)}`} onClick={() => { setSelectedId(t.id); setDraft(null); }}>
        <strong>{t.label}</strong><span>{STATE_LABEL[tableState(t)]}</span>{t.activeOrder && <small>{euro(Number(t.activeOrder.grossTotal) - Number(t.activeOrder.paidTotal))}</small>}
      </button>)}</div>

      <aside className="table-panel">
        {draft && editMode ? <form onSubmit={createTable} className="table-form">
          <p className="eyebrow">NUEVA MESA</p><h3>Añadir mesa en {currentZone}</h3>
          <label>Nombre<input name="label" required autoFocus placeholder={`Mesa ${tables.length + 1}`} defaultValue={`${currentZone === 'Salón' ? 'Mesa' : currentZone} ${zoneTables.length + 1}`} /></label>
          <input type="hidden" name="zone" value={currentZone} />
          <label>Forma<select name="shape" defaultValue="square"><option value="square">Cuadrada</option><option value="round">Redonda</option><option value="rect">Rectangular</option><option value="bar">Barra / taburete</option></select></label>
          <label>Diámetro redonda (cm)<input name="diameterCm" type="number" min="50" max="200" step="0.5" list="round-diameters" value={draftDiameter} onChange={e => { const v = Number(e.target.value); setDraftDiameter(v); setDraftSeats(roundRecommended(v)); }} /></label>
          <datalist id="round-diameters">{ROUND.map(([d, seats]) => <option key={d} value={d}>{seats} plazas recomendadas</option>)}</datalist>
          <label>Lado cuadrada (cm)<input name="widthCm" type="number" min="50" max="150" step="1" list="square-sides" value={draftSide} onChange={e => { const v = Number(e.target.value); setDraftSide(v); setDraftSeats(squareRecommended(v)); }} /></label>
          <datalist id="square-sides">{SQUARE.map(([side, seats]) => <option key={side} value={side}>{seats} plazas recomendadas</option>)}</datalist>
          <label>Ancho rectangular (cm)<input type="number" min="80" max="240" step="1" list="rect-widths" value={draftWidth} onChange={e => { const w = Number(e.target.value); setDraftWidth(w); setDraftSeats(rectRecommended(w, draftSides)); }} /></label>
          <label>Alto rectangular (cm)<input type="number" min="60" max="120" step="1" list="rect-heights" value={draftHeight} onChange={e => setDraftHeight(Number(e.target.value))} /></label>
          <datalist id="rect-widths">{[80, 120, 160, 200, 240].map(v => <option key={v} value={v} />)}</datalist>
          <datalist id="rect-heights">{[60, 80, 100].map(v => <option key={v} value={v} />)}</datalist>
          <fieldset className="side-picker"><legend>Lados usados</legend>{RECT_SIDES.map(side => <label key={side}><input type="checkbox" checked={draftSides.includes(side)} onChange={() => toggleSide(side, draftSides, setDraftSides, draftWidth, setDraftSeats)} /> {SIDE_LABEL[side]}</label>)}</fieldset>
          <label>Plazas<input name="seats" type="number" min="1" max="20" step="1" value={draftSeats} onChange={e => setDraftSeats(Number(e.target.value))} required /></label>
          <small className="measure-note">Redonda 50-200 cm; cuadrada 50-150 cm; rectangular 80-240 × 60-120 cm. Recomendación rectangular: {rectRecommended(draftWidth, draftSides)} plazas.</small>
          <div className="modal-actions"><button type="button" className="secondary" onClick={() => setDraft(null)}>Cancelar</button><button className="primary">Añadir mesa</button></div>
        </form>
        : !selected ? <div className="empty">{editMode ? <>Arrastra una mesa para moverla, suéltala sobre otra contigua para unirlas, o toca una casilla vacía para crear una nueva.<br /><br /><button className="secondary" onClick={() => setDraft(nextFreeCell())}>＋ Añadir mesa</button></> : 'Selecciona una mesa del plano.'}</div>
        : editMode ? <form key={selected.id} onSubmit={saveTable} className="table-form">
          <p className="eyebrow">EDITAR MESA</p><h3>{selected.label}</h3>
          <p className="modal-description">Para moverla, arrástrala o toca una casilla vacía del plano.</p>
          <label>Nombre<input name="label" required defaultValue={selected.label} /></label>
          <label>Sala<input name="zone" required defaultValue={selected.zone} list="zones-list" /><datalist id="zones-list">{zones.map(z => <option key={z} value={z} />)}</datalist></label>
          <label>Forma<select name="shape" defaultValue={selected.shape}><option value="square">Cuadrada</option><option value="round">Redonda</option><option value="rect">Rectangular</option><option value="bar">Barra / taburete</option></select></label>
          <label>Diámetro redonda (cm)<input name="diameterCm" type="number" min="50" max="200" step="0.5" list="round-diameters-edit" value={editDiameter} onChange={e => { const v = Number(e.target.value); setEditDiameter(v); setEditSeats(roundRecommended(v)); }} /></label>
          <datalist id="round-diameters-edit">{ROUND.map(([d, seats]) => <option key={d} value={d}>{seats} plazas recomendadas</option>)}</datalist>
          <label>Lado cuadrada (cm)<input name="widthCm" type="number" min="50" max="150" step="1" list="square-sides-edit" value={editSide} onChange={e => { const v = Number(e.target.value); setEditSide(v); setEditSeats(squareRecommended(v)); }} /></label>
          <datalist id="square-sides-edit">{SQUARE.map(([side, seats]) => <option key={side} value={side}>{seats} plazas recomendadas</option>)}</datalist>
          <label>Ancho rectangular (cm)<input type="number" min="80" max="240" step="1" list="rect-widths-edit" value={editWidth} onChange={e => { const w = Number(e.target.value); setEditWidth(w); setEditSeats(rectRecommended(w, editSides)); }} /></label>
          <label>Alto rectangular (cm)<input type="number" min="60" max="120" step="1" list="rect-heights-edit" value={editHeight} onChange={e => setEditHeight(Number(e.target.value))} /></label>
          <datalist id="rect-widths-edit">{[80, 120, 160, 200, 240].map(v => <option key={v} value={v} />)}</datalist>
          <datalist id="rect-heights-edit">{[60, 80, 100].map(v => <option key={v} value={v} />)}</datalist>
          <fieldset className="side-picker"><legend>Lados usados</legend>{RECT_SIDES.map(side => <label key={side}><input type="checkbox" checked={editSides.includes(side)} onChange={() => toggleSide(side, editSides, setEditSides, editWidth, setEditSeats)} /> {SIDE_LABEL[side]}</label>)}</fieldset>
          <label>Plazas<input name="seats" type="number" min="1" max="20" step="1" value={editSeats} onChange={e => setEditSeats(Number(e.target.value))} required /></label>
          <small className="measure-note">Recomendaciones: redonda {roundRecommended(editDiameter)}, cuadrada {squareRecommended(editSide)}, rectangular {rectRecommended(editWidth, editSides)} plazas.</small>
          {selected.joinedCount > 0 && <button type="button" className="secondary wide-secondary" onClick={() => void splitTable()}>Separar mesas</button>}
          {joinable.length > 0 && <div className="join-options"><span>Unir con</span>{joinable.map(t => <button type="button" key={t.id} className="secondary" onClick={() => void joinTables(selected, t)}>{t.label}</button>)}</div>}
          <div className="modal-actions"><button type="button" className="remove-button" onClick={() => void removeTable()}>Eliminar mesa</button><button className="primary">Guardar</button></div>
        </form>
        : <div className="table-detail">
          <p className="eyebrow">{selected.zone.toUpperCase()} · {selected.seats} PLAZAS</p>
          <h3>{selected.label}</h3>
          {canEdit&&selected.qrToken&&<><button className="secondary wide-secondary" onClick={()=>{const url=`${window.location.origin}/?qr=${encodeURIComponent(selected.qrToken!)}`;void navigator.clipboard.writeText(url).then(()=>setNotice(`Enlace QR de ${selected.label} copiado.`)).catch(()=>setError(`Enlace QR: ${url}`))}}>Copiar enlace de pedido QR</button><button className="text-button wide-secondary" onClick={()=>void rotateQrToken()}>Regenerar QR</button></>}
          <span className={`state-pill ${tableState(selected)}`}>{STATE_LABEL[tableState(selected)]}</span>
          {selected.joinedCount > 0 && <p className="measure-info">{cellsX(selected)} × {cellsY(selected)} casillas · {selected.joinedCount} unión(es)</p>}
          {selected.diameterCm != null && <p className="measure-info">Ø {Number(selected.diameterCm).toFixed(1)} cm · {selected.seatsRecommended} plazas recomendadas</p>}
          {selected.shape === 'square' && selected.widthCm != null && <p className="measure-info">{Number(selected.widthCm)} × {Number(selected.heightCm)} cm · {selected.seatsRecommended} plazas recomendadas</p>}
          {selected.shape === 'rect' && selected.widthCm != null && <p className="measure-info">{Number(selected.widthCm)} × {Number(selected.heightCm)} cm · lados {selected.sidesUsed?.join(', ') || '—'} · {selected.seatsRecommended} plazas recomendadas</p>}
          {selected.seatsWarning && <p className="measure-warning">Capacidad personalizada: se desvía de la calculada para esas medidas.</p>}
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
