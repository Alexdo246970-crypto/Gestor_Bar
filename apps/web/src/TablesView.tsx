import { FormEvent, TouchEvent, useEffect, useMemo, useRef, useState } from 'react';
import { API, DiningTable, OrderDetail, euro, request } from './lib';
import { PaymentModal } from './PaymentModal';

export const GRID_COLS = 8, GRID_ROWS = 5;
export const CM_PER_CELL = 40;
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
const PX_PER_CM = 2;
/** Medidas visuales en centímetros: una unión usa su envolvente, no la mesa original. */
export function tableCm(t: DiningTable) {
  if (t.joinedCount > 0 || spanX(t) > 1 || spanY(t) > 1) return { w: spanX(t) * CM_PER_CELL, h: spanY(t) * CM_PER_CELL };
  if (t.shape === 'round') return { w: Number(t.diameterCm) || 90, h: Number(t.diameterCm) || 90 };
  return { w: Number(t.widthCm) || (t.shape === 'bar' ? 120 : 80), h: Number(t.heightCm) || (t.shape === 'bar' ? 60 : 80) };
}
const cellsX = (t: DiningTable) => Math.max(1, Math.round(tableCm(t).w / CM_PER_CELL), spanX(t));
const cellsY = (t: DiningTable) => Math.max(1, Math.round(tableCm(t).h / CM_PER_CELL), spanY(t));
const covers = (t: DiningTable, x: number, y: number) => x >= t.posX && x < t.posX + cellsX(t) && y >= t.posY && y < t.posY + cellsY(t);
/** Cualquier par de mesas se puede unir (da igual su forma o posición) salvo que las dos tengan comanda abierta. */
export function canJoin(a: DiningTable, b: DiningTable) {
  return a.id !== b.id && !(a.activeOrder && b.activeOrder);
}
/** Solapamiento real (en cm), avisado pero no bloqueado para poder corregir importaciones. */
function intersects(a: DiningTable, b: DiningTable) {
  const ax = a.posX * CM_PER_CELL, ay = a.posY * CM_PER_CELL, bx = b.posX * CM_PER_CELL, by = b.posY * CM_PER_CELL;
  const aSize = tableCm(a), bSize = tableCm(b);
  return ax < bx + bSize.w && bx < ax + aSize.w && ay < by + bSize.h && by < ay + aSize.h;
}

/** Plano de sala: cada mesa muestra en tiempo real el estado de su comanda. */
export function TablesView({ canEdit, onOpenInPos }: { canEdit: boolean; onOpenInPos: (table: { id: string; label: string }) => void }) {
  const [tables, setTables] = useState<DiningTable[]>([]), [rooms, setRooms] = useState<Room[]>([]), [zone, setZone] = useState(() => { try { return localStorage.getItem('barros-room') || ''; } catch { return ''; } }), [selectedId, setSelectedId] = useState<string | null>(null), [detail, setDetail] = useState<OrderDetail | null>(null), [editMode, setEditMode] = useState(false), [paying, setPaying] = useState<string | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [draft, setDraft] = useState<{ posX: number; posY: number } | null>(null), [dragId, setDragId] = useState<string | null>(null), [pendingZone, setPendingZone] = useState<string | null>(null), [zoom, setZoom] = useState(1);
  const [qrSettings,setQrSettings]=useState({approvalRequired:false,maxOrderLines:20,cooldownSeconds:120}),[showQrSettings,setShowQrSettings]=useState(false);
  const [roomForm,setRoomForm]=useState<{mode:'create'|'edit';id?:string;name:string;widthCm:number;heightCm:number;sortOrder:number}|null>(null);
  const [visibleStates,setVisibleStates]=useState<TableState[]>(['free', 'open', 'sent', 'partial']);
  const [lastMove,setLastMove]=useState<{id:string;posX:number;posY:number}|null>(null);
  const pinch = useRef<number | null>(null);

  async function load() {
    try {
      const [list, roomList] = await Promise.all([request<DiningTable[]>('/tables'), request<Room[]>('/rooms')]);
      setTables(list); setRooms(roomList);
    } catch (e) { setError((e as Error).message); }
  }
  function openRoomForm(mode: 'create' | 'edit') {
    const room = rooms.find(r => r.name === currentZone);
    setRoomForm({ mode, id: room?.id, name: mode === 'edit' ? room?.name || '' : '',
      widthCm: room?.widthCm ?? 800, heightCm: room?.heightCm ?? 500, sortOrder: room?.sortOrder ?? rooms.length });
    setSelectedId(null); setDraft(null);
  }
  async function saveRoom(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!roomForm) return;
    const body = JSON.stringify({ name: roomForm.name.trim(), widthCm: Number(roomForm.widthCm), heightCm: Number(roomForm.heightCm), sortOrder: Number(roomForm.sortOrder) });
    try {
      const room = await request<Room>(roomForm.mode === 'create' ? '/rooms' : `/rooms/${roomForm.id}`,
        { method: roomForm.mode === 'create' ? 'POST' : 'PATCH', body });
      await load(); setZone(room.name); setRoomForm(null);
      setNotice(roomForm.mode === 'create' ? `Sala «${room.name}» creada.` : 'Sala actualizada; las mesas y comandas se han conservado.');
    } catch (err) { setError((err as Error).message); }
  }
  /** Agranda o reduce la sala casilla a casilla (40 cm); nunca deja mesas fuera del plano. */
  async function resizeRoom(dCols: number, dRows: number) {
    const room = rooms.find(r => r.name === currentZone); if (!room) return;
    const usedCols = Math.max(1, ...zoneTables.map(t => t.posX + cellsX(t))), usedRows = Math.max(1, ...zoneTables.map(t => t.posY + cellsY(t)));
    const cols = floorCols + dCols, rows = floorRows + dRows;
    if (cols < usedCols || rows < usedRows) { setError('Hay mesas en esa parte de la sala; muévelas antes de reducirla.'); return; }
    const widthCm = Math.min(10000, Math.max(100, cols * CM_PER_CELL)), heightCm = Math.min(10000, Math.max(100, rows * CM_PER_CELL));
    setRooms(list => list.map(r => r.id === room.id ? { ...r, widthCm, heightCm } : r));
    try { await request(`/rooms/${room.id}`, { method: 'PATCH', body: JSON.stringify({ widthCm, heightCm }) }); }
    catch (err) { setError((err as Error).message); void load(); }
  }
  async function archiveRoom() {
    const room = rooms.find(r => r.name === currentZone); if (!room) return;
    if (!confirm(`¿Archivar «${room.name}»? Las mesas y el histórico se conservan; solo desaparece del servicio.`)) return;
    try {
      const result = await request<{ archivedWithOpenOrders?: boolean }>(`/rooms/${room.id}?force=true`, { method: 'DELETE' });
      await load(); setZone(''); setRoomForm(null);
      setNotice(result.archivedWithOpenOrders ? 'Sala archivada con comandas abiertas; el histórico se conserva.' : 'Sala archivada; el histórico se conserva.');
    } catch (err) { setError((err as Error).message); }
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
  useEffect(() => { try { localStorage.setItem('barros-room', currentZone); } catch { /* modo privado */ } }, [currentZone]);
  const zoneTables = tables.filter(t => t.zone === currentZone);
  const currentRoom = rooms.find(r => r.name === currentZone);
  const floorCols = Math.max(1, Math.ceil((currentRoom?.widthCm ?? GRID_COLS * CM_PER_CELL) / CM_PER_CELL));
  const floorRows = Math.max(1, Math.ceil((currentRoom?.heightCm ?? GRID_ROWS * CM_PER_CELL) / CM_PER_CELL));
  const visibleTables = zoneTables.filter(t => visibleStates.includes(tableState(t)));
  const overlapping = new Set<string>();
  for (let i = 0; i < zoneTables.length; i++) for (let j = i + 1; j < zoneTables.length; j++) {
    if (intersects(zoneTables[i], zoneTables[j])) { overlapping.add(zoneTables[i].id); overlapping.add(zoneTables[j].id); }
  }
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

  async function move(id: string, posX: number, posY: number, record = true) {
    const t = tables.find(x => x.id === id); if (!t) return;
    const w = cellsX(t), h = cellsY(t);
    if (posX + w > floorCols || posY + h > floorRows) { setError('La mesa no cabe en esa posición del plano.'); return; }
    if (zoneTables.some(o => o.id !== id && o.posX < posX + w && posX < o.posX + cellsX(o) && o.posY < posY + h && posY < o.posY + cellsY(o))) { setError('Hay otra mesa en ese hueco.'); return; }
    const previous = { id, posX: t.posX, posY: t.posY };
    setTables(current => current.map(x => x.id === id ? { ...x, posX, posY } : x));
    try {
      await request(`/tables/${id}`, { method: 'PATCH', body: JSON.stringify({ posX, posY }) });
      if (record) { setLastMove(previous); setNotice(`${t.label} movida a la casilla ${posX + 1}, ${posY + 1}.`); }
      else setLastMove(null);
    } catch (e) { setError((e as Error).message); void load(); }
  }
  function clickCell(posX: number, posY: number) {
    if (!editMode) { setSelectedId(null); return; }
    if (selected && selected.zone === currentZone) { void move(selected.id, posX, posY); return; }
    setDraft({ posX, posY }); setSelectedId(null);
  }
  const touchDistance = (e: TouchEvent<HTMLDivElement>) => {
    const [a, b] = [e.touches[0], e.touches[1]];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };
  function pinchStart(e: TouchEvent<HTMLDivElement>) { pinch.current = e.touches.length === 2 ? touchDistance(e) : null; }
  function pinchMove(e: TouchEvent<HTMLDivElement>) {
    if (e.touches.length !== 2) return;
    const current = touchDistance(e);
    if (pinch.current) setZoom(z => Math.min(3, Math.max(0.5, Math.round((z * current / pinch.current!) * 100) / 100)));
    pinch.current = current;
  }
  function undoMove() {
    if (!lastMove) return;
    void move(lastMove.id, lastMove.posX, lastMove.posY, false);
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
    const shape = selected.joinedCount === 0 && f.get('shape') ? String(f.get('shape')) : undefined;
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
    if (!confirm(`¿Unir ${target.label} y ${other.label}? La mesa unida ocupará el espacio de las dos y sumará sus plazas.`)) return;
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
  async function inviteOrder() {
    if (!selected?.activeOrder) return;
    if (!confirm(`¿Invitar ${selected.label} por ${euro(Number(selected.activeOrder.grossTotal))}? Se registrará como pérdida y no se contabilizará como venta.`)) return;
    try {
      await request(`/orders/${selected.activeOrder.id}/invite`, { method: 'POST', body: JSON.stringify({ notes: `Invitación desde ${selected.label}` }) });
      setSelectedId(null); await load(); setNotice(`${selected.label} invitada; la pérdida ya aparece en el informe.`);
    } catch (err) { setError((err as Error).message); }
  }
  function nextFreeCell() { for (let y = 0; y < floorRows; y++) for (let x = 0; x < floorCols; x++) if (!zoneTables.some(t => covers(t, x, y))) return { posX: x, posY: y }; return { posX: 0, posY: 0 }; }

  // El fondo es la sala a escala; las mesas se dibujan encima con su tamaño real en cm.
  const cellPx = CM_PER_CELL * PX_PER_CM * zoom;
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < floorRows; y++) for (let x = 0; x < floorCols; x++) {
    if (!zoneTables.some(t => covers(t, x, y))) cells.push({ x, y });
  }
  const dragged = dragId ? tables.find(t => t.id === dragId) : undefined;
  const joinable = selected && editMode ? zoneTables.filter(t => canJoin(selected, t)) : [];
  const offGrid = zoneTables.filter(t => t.posX >= floorCols || t.posY >= floorRows);

  return <section className="tables-page">
    <div className="section-head"><div><h3>Mapa de mesas</h3><p>Toca una mesa para abrir su comanda, añadir productos o cobrar</p></div>
      <div className="tables-head-actions">
        <span className={`mode-badge ${editMode ? 'edit' : 'service'}`}>{editMode ? '✎ Edición' : '▣ Servicio'}</span>
        {lastMove && <button className="secondary" onClick={undoMove}>↶ Deshacer movimiento</button>}
        <button className="secondary" onClick={() => void load()}>Actualizar ↻</button>
        <button className="secondary" onClick={() => setZoom(z => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))} aria-label="Reducir zoom">−</button><span className="zoom-label">{Math.round(zoom * 100)} %</span><button className="secondary" onClick={() => setZoom(z => Math.min(3, Math.round((z + 0.25) * 100) / 100))} aria-label="Aumentar zoom">＋</button><button className="secondary" onClick={() => setZoom(1)}>Ajustar</button>
        {canEdit && <button className="secondary" onClick={()=>setShowQrSettings(v=>!v)}>Ajustes QR</button>}{canEdit && <button className={editMode ? 'primary' : 'secondary'} onClick={() => { setEditMode(!editMode); setDraft(null); setRoomForm(null); }}>{editMode ? 'Terminar edición' : '✎ Editar plano'}</button>}
      </div></div>
    {error && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    {notice && <div className="order-notice" onClick={() => setNotice('')}>✓ {notice}</div>}
    {showQrSettings&&canEdit&&<form className="table-form qr-settings-form" onSubmit={saveQrSettings}><p className="eyebrow">PEDIDOS QR</p><h3>Control de pedidos</h3><label className="checkbox-row"><input type="checkbox" name="approvalRequired" defaultChecked={qrSettings.approvalRequired}/> Requerir aprobación del personal antes de enviar a cocina</label><div className="form-pair"><label>Máximo de líneas (1–20)<input name="maxOrderLines" type="number" min="1" max="20" defaultValue={qrSettings.maxOrderLines} required/></label><label>Espera entre pedidos (segundos)<input name="cooldownSeconds" type="number" min="0" max="3600" defaultValue={qrSettings.cooldownSeconds} required/></label></div><div className="modal-actions"><button type="button" className="secondary" onClick={()=>setShowQrSettings(false)}>Cancelar</button><button className="primary">Guardar ajustes</button></div></form>}
    <div className="table-stats">
      <article><span>Mesas libres</span><strong>{tables.length - busy.length}</strong><small>de {tables.length}</small></article>
      <article><span>Ocupadas</span><strong>{busy.length}</strong><small>con comanda abierta</small></article>
      <article><span>Pendiente de cobro</span><strong>{euro(openAmount)}</strong><small>en sala</small></article>
    </div>
    <div className="zone-tabs">{zones.map(z => <button key={z} className={z === currentZone ? 'selected' : ''} onClick={() => { setZone(z); setSelectedId(null); setDraft(null); }}>{z}<span>{tables.filter(t => t.zone === z && t.activeOrder).length}/{tables.filter(t => t.zone === z).length}</span></button>)}
      {editMode && <button className="zone-add" onClick={() => openRoomForm('create')}>＋ Sala</button>}
      {editMode && rooms.some(r => r.name === currentZone) && <button className="zone-add" onClick={() => openRoomForm('edit')}>✎ Editar sala</button>}
      {editMode && rooms.some(r => r.name === currentZone) && <button className="zone-add" onClick={() => void archiveRoom()}>Archivar sala</button>}
    </div>
    <div className="legend">{(['free', 'open', 'sent', 'partial'] as TableState[]).map(st => {
      const active = visibleStates.includes(st);
      return <button key={st} type="button" aria-pressed={active} className={active ? '' : 'muted'} onClick={() => setVisibleStates(list => active ? list.filter(s => s !== st) : [...list, st])}>
        <i className={`dot ${st}`} />{STATE_LABEL[st]} <b>{zoneTables.filter(t => tableState(t) === st).length}</b>
      </button>;
    })}{overlapping.size > 0 && <span className="overlap-warning">⚠ {overlapping.size} mesa(s) solapada(s)</span>}</div>
    {editMode && currentRoom && <div className="floor-size">
      <span>Tamaño de «{currentZone}»: {(currentRoom.widthCm / 100).toLocaleString('es')} × {(currentRoom.heightCm / 100).toLocaleString('es')} m</span>
      <div><button type="button" className="secondary" onClick={() => void resizeRoom(-1, 0)} aria-label="Estrechar sala">−</button><strong>Ancho {floorCols}</strong><button type="button" className="secondary" onClick={() => void resizeRoom(1, 0)} aria-label="Ensanchar sala">＋</button></div>
      <div><button type="button" className="secondary" onClick={() => void resizeRoom(0, -1)} aria-label="Acortar sala">−</button><strong>Largo {floorRows}</strong><button type="button" className="secondary" onClick={() => void resizeRoom(0, 1)} aria-label="Alargar sala">＋</button></div>
      <div><button type="button" className="secondary" onClick={() => void resizeRoom(5, 5)}>＋ Ampliar 2 m</button></div>
    </div>}
    <div className="tables-layout">
      <div className="floor-scroll" onTouchStart={pinchStart} onTouchMove={pinchMove} onTouchEnd={() => { pinch.current = null; }}>
        <div className={`floor ${editMode ? 'editing' : ''}`} style={{
          gridTemplateColumns: `repeat(${floorCols}, ${cellPx}px)`, gridTemplateRows: `repeat(${floorRows}, ${cellPx}px)`,
          width: floorCols * cellPx, height: floorRows * cellPx
        }}>
          {cells.map(({ x, y }) => <div key={`${x}-${y}`} style={{ gridColumn: x + 1, gridRow: y + 1 }}
            className={`floor-cell ${draft && draft.posX === x && draft.posY === y ? 'draft' : ''}`} onClick={() => clickCell(x, y)}
            onDragOver={e => { if (editMode) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (dragId) void move(dragId, x, y); setDragId(null); }}>
            {editMode && <span>＋</span>}
          </div>)}
          {visibleTables.filter(t => t.posX < floorCols && t.posY < floorRows).map(table => {
            const cm = tableCm(table), w = Math.max(48, cm.w * PX_PER_CM * zoom), h = Math.max(36, cm.h * PX_PER_CM * zoom);
            return <button key={table.id} draggable={editMode} onDragStart={() => setDragId(table.id)} onDragEnd={() => setDragId(null)}
              style={{ gridColumn: table.posX + 1, gridRow: table.posY + 1, width: w, height: h }}
              onDragOver={e => { if (editMode && dragged && canJoin(dragged, table)) e.preventDefault(); }}
              onDrop={e => { e.preventDefault(); if (dragged && canJoin(dragged, table)) void joinTables(table, dragged); setDragId(null); }}
              className={`dining-table ${table.shape} ${tableState(table)} ${selectedId === table.id ? 'selected' : ''} ${dragged && canJoin(dragged, table) ? 'join-target' : ''} ${overlapping.has(table.id) ? 'overlap' : ''} ${table.joinedCount > 0 ? 'joined' : ''}`}
              onClick={() => { setSelectedId(table.id); setDraft(null); setRoomForm(null); }}
              title={`${table.label} · ${cm.w} × ${cm.h} cm · ${table.seats} plazas${overlapping.has(table.id) ? ' · ⚠ solapada' : ''}`}
              aria-label={`${table.label}: ${STATE_LABEL[tableState(table)]}, ${table.seats} plazas${overlapping.has(table.id) ? ', solapada' : ''}`}>
              <strong>{table.label}</strong>
              {table.joinedCount > 0 && <small className="join-badge">{table.seats} plazas · {table.joinedCount} unión(es)</small>}
              {table.activeOrder ? <><span className="t-total">{euro(Number(table.activeOrder.grossTotal) - Number(table.activeOrder.paidTotal))}</span><small>{minutesSince(table.activeOrder.openedAt)} min · #{table.activeOrder.orderNumber}</small></> : <small>{table.seats} {table.seats === 1 ? 'plaza' : 'plazas'}</small>}
            </button>;
          })}
          {offGrid.map(t => <button key={t.id} className="dining-table offgrid overlap" onClick={() => setSelectedId(t.id)}>{t.label} ⚠ fuera del plano</button>)}
        </div>
      </div>
      <div className="mobile-table-list">{visibleTables.map(t => <button key={t.id} className={`mobile-table ${tableState(t)}`} onClick={() => { setSelectedId(t.id); setDraft(null); setRoomForm(null); }}>
        <strong>{t.label}</strong><span>{STATE_LABEL[tableState(t)]}</span>{t.activeOrder && <small>{euro(Number(t.activeOrder.grossTotal) - Number(t.activeOrder.paidTotal))}</small>}
      </button>)}</div>

      <aside className="table-panel">
        {roomForm ? <form onSubmit={saveRoom} className="table-form">
          <p className="eyebrow">{roomForm.mode === 'create' ? 'NUEVA SALA' : 'EDITAR SALA'}</p>
          <h3>{roomForm.mode === 'create' ? 'Añadir sala al plano' : roomForm.name}</h3>
          <p className="modal-description">La sala puede estar vacía. Renombrarla conserva mesas y comandas; archivarla oculta del servicio sin borrar el histórico.</p>
          <label>Nombre<input required autoFocus value={roomForm.name} onChange={e => setRoomForm({ ...roomForm, name: e.target.value })} placeholder="Terraza, Salón…" /></label>
          <div className="form-pair"><label>Ancho de la sala (cm)<input type="number" required min="100" max="10000" step="1" value={roomForm.widthCm} onChange={e => setRoomForm({ ...roomForm, widthCm: Number(e.target.value) })} /></label>
            <label>Alto de la sala (cm)<input type="number" required min="100" max="10000" step="1" value={roomForm.heightCm} onChange={e => setRoomForm({ ...roomForm, heightCm: Number(e.target.value) })} /></label></div>
          <label>Orden en el selector<input type="number" min="-999" max="999" step="1" value={roomForm.sortOrder} onChange={e => setRoomForm({ ...roomForm, sortOrder: Number(e.target.value) })} /></label>
          <small className="measure-note">Las dimensiones fijan el área visible del plano a escala 1 cm = 2 px.</small>
          <div className="modal-actions"><button type="button" className="secondary" onClick={() => setRoomForm(null)}>Cancelar</button><button className="primary">{roomForm.mode === 'create' ? 'Crear sala' : 'Guardar sala'}</button></div>
        </form>
        : draft && editMode ? <form onSubmit={createTable} className="table-form">
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
        : !selected ? <div className="empty">{editMode ? <>Arrastra una mesa para moverla, suéltala sobre cualquier otra para unirlas, o toca una casilla vacía para crear una nueva.<br /><br /><button className="secondary" onClick={() => setDraft(nextFreeCell())}>＋ Añadir mesa</button></> : 'Selecciona una mesa del plano.'}</div>
        : editMode ? <form key={selected.id} onSubmit={saveTable} className="table-form">
          <p className="eyebrow">EDITAR MESA</p><h3>{selected.label}</h3>
          <p className="modal-description">Para moverla, arrástrala o toca una casilla vacía del plano.</p>
          <label>Nombre<input name="label" required defaultValue={selected.label} /></label>
          <label>Sala<input name="zone" required defaultValue={selected.zone} list="zones-list" /><datalist id="zones-list">{zones.map(z => <option key={z} value={z} />)}</datalist></label>
          {selected.joinedCount > 0 ? <p className="measure-info">Mesa unida de {cellsX(selected) * CM_PER_CELL} × {cellsY(selected) * CM_PER_CELL} cm. Sepárala para cambiar su forma o medidas.</p> : <>
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
          <small className="measure-note">Recomendaciones: redonda {roundRecommended(editDiameter)}, cuadrada {squareRecommended(editSide)}, rectangular {rectRecommended(editWidth, editSides)} plazas.</small>
          </>}
          <label>Plazas<input name="seats" type="number" min="1" max={selected.joinedCount > 0 ? 200 : 20} step="1" value={editSeats} onChange={e => setEditSeats(Number(e.target.value))} required /></label>
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
            {canEdit && !Number(selected.activeOrder.paidTotal) && <button className="secondary wide-secondary" onClick={() => void inviteOrder()}>Invitar comanda (registrar pérdida)</button>}
            <button className="primary wide" disabled={Number(selected.activeOrder.grossTotal) <= 0} onClick={() => setPaying(selected.activeOrder!.id)}>Cobrar mesa <span>{euro(Number(selected.activeOrder.grossTotal) - Number(selected.activeOrder.paidTotal))}</span></button>
          </>}
        </div>}
      </aside>
    </div>
    {paying && <PaymentModal orderId={paying} onClose={() => { setPaying(null); void load(); }} onPaid={closed => { void load(); if (closed) setNotice(`${selected?.label || 'Mesa'} cobrada y liberada.`); }} />}
  </section>;

}
