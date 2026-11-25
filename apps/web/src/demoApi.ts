// Backend simulado en memoria para VITE_DEMO_MODE=true. Replica las reglas principales de la API real
// (una comanda activa por mesa, pagos por tarjeta TPV o efectivo, cierre al completar el total).
import type { Product } from '@bar/contracts';

type DemoProduct = Product & { description?: string | null; categoryName?: string | null; [extra: string]: unknown };
type DemoLine = { id: string; productId: string; productName: string; quantity: number; lineGross: number };
type DemoPayment = { id: string; method: 'cash' | 'card'; amount: number; cashTendered: number | null; changeGiven: number | null; cardReference: string | null; paidAt: string };
type DemoOrder = { id: string; orderNumber: number; status: 'open' | 'sent' | 'paid'; channel: string; tableId: string | null; tableLabel: string | null; openedAt: string; lines: DemoLine[]; payments: DemoPayment[] };
type JoinSnapshot = { joinedId: string; label: string; seats: number; shape: DemoTable['shape']; spanX: number; spanY: number; offX: number; offY: number; joinedOffX: number; joinedOffY: number };
type DemoTable = { id: string; label: string; zone: string; seats: number; shape: 'square' | 'round' | 'bar' | 'rect'; posX: number; posY: number; diameterCm?: number; widthCm?: number; heightCm?: number; sidesUsed?: string[]; seatsRecommended?: number; seatsWarning?: boolean; spanX?: number; spanY?: number; mergedFrom?: JoinSnapshot[]; active?: boolean };
type Store = { products: DemoProduct[]; categories: { id: string; name: string; sortOrder: number }[]; tables: DemoTable[]; orders: DemoOrder[]; nextOrder: number };

const STORAGE_KEY = 'barraos-demo-v2';
let seedProducts: DemoProduct[] = [];
let store: Store | null = null;

export function seedDemoProducts(products: Product[]) { seedProducts = products as DemoProduct[]; }

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const round = (n: number) => Math.round(n * 100) / 100;
const gross = (o: DemoOrder) => round(o.lines.reduce((s, l) => s + l.lineGross, 0));
const paid = (o: DemoOrder) => round(o.payments.reduce((s, p) => s + p.amount, 0));
const fail = (message: string): never => { throw new Error(message); };
const ROUND: [number, number][] = [[70, 3], [90, 4], [120, 8], [150, 10]];
const SQUARE: [number, number][] = [[70, 2], [80, 4], [90, 4], [100, 6], [120, 8]];
const roundRecommended = (d: number) => ROUND.reduce((best, item) => Math.abs(item[0] - d) < Math.abs(best[0] - d) ? item : best)[1];
const squareRecommended = (side: number) => SQUARE.reduce((best, item) => Math.abs(item[0] - side) < Math.abs(best[0] - side) ? item : best)[1];
const roundWarning = (t: DemoTable) => t.seatsRecommended != null && Math.abs(t.seats - t.seatsRecommended) > 1;
const squareWarning = (t: DemoTable) => t.seatsRecommended != null && Math.abs(t.seats - t.seatsRecommended) > 2;
const shapeWarning = (t: DemoTable) => t.shape === 'round' ? roundWarning(t) : squareWarning(t);
function roundDiameter(value: unknown) {
  const d = Number(value ?? 90);
  if (!(d >= 50 && d <= 200) || Math.abs(d * 2 - Math.round(d * 2)) > 1e-9) fail('Diámetro no válido (50-200 cm, pasos de 0,5 cm)');
  return d;
}
function squareSide(value: unknown) {
  const side = Number(value ?? 80);
  if (!Number.isInteger(side) || side < 50 || side > 150) fail('Lado no válido (50-150 cm)');
  return side;
}
const SIDES = ['long1', 'long2', 'short1', 'short2'];
const rectRecommended = (width: number, sides: string[]) => {
  if (!sides.length) return 0;
  const longs = sides.filter(s => s.startsWith('long')).length;
  return Math.min(20, Math.max(1, Math.floor(width / 60) * longs + (sides.length - longs)));
};
function rectMeasures(b: any, current?: DemoTable) {
  const width = Number(b.widthCm ?? current?.widthCm ?? 120), height = Number(b.heightCm ?? current?.heightCm ?? 80);
  if (!Number.isInteger(width) || width < 80 || width > 240) fail('Ancho no válido (80-240 cm)');
  if (!Number.isInteger(height) || height < 60 || height > 120) fail('Alto no válido (60-120 cm)');
  const sides = (b.sidesUsed ?? current?.sidesUsed ?? ['long1', 'long2']).filter((s: string) => SIDES.includes(s));
  if (!sides.length) fail('Marca al menos un lado de la mesa');
  return { width, height, sides, recommended: rectRecommended(width, sides) };
}

function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* almacenamiento no disponible */ } }

function load(): Store {
  if (store) return store;
  try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) { store = JSON.parse(raw); return store!; } } catch { /* ignorar */ }
  const categoryNames = [...new Set(seedProducts.map(p => String(p.categoryId)))];
  const tables: DemoTable[] = [
    ...[1, 2, 3, 4, 5, 6].map((n, i) => { const shape = (n % 3 === 0 ? 'round' : 'square') as DemoTable['shape']; const seats = n === 5 || n === 6 ? 6 : 4; const diameterCm = shape === 'round' ? (seats <= 4 ? 90 : 120) : undefined; const widthCm = shape === 'square' ? 80 : undefined; return { id: `t-salon-${n}`, label: `Mesa ${n}`, zone: 'Salón', seats, shape, diameterCm, widthCm, heightCm: widthCm, seatsRecommended: diameterCm ? roundRecommended(diameterCm) : (widthCm ? squareRecommended(widthCm) : undefined), posX: 1 + (i % 3) * 2, posY: 1 + Math.floor(i / 3) * 2 }; }),
    ...[1, 2, 3, 4].map((n, i) => ({ id: `t-terraza-${n}`, label: `Terraza ${n}`, zone: 'Terraza', seats: 2, shape: 'round' as const, diameterCm: 90, seatsRecommended: 4, posX: 1 + i * 2, posY: 1 })),
    ...[1, 2, 3].map((n, i) => ({ id: `t-barra-${n}`, label: `Barra ${n}`, zone: 'Barra', seats: 1, shape: 'rect' as const, widthCm: 120, heightCm: 60, sidesUsed: ['long1'], seatsRecommended: 2, posX: 1 + i, posY: 1 })),
  ];
  store = { products: seedProducts.map(p => ({ ...p, categoryName: String(p.categoryId) })), categories: categoryNames.map((name, i) => ({ id: name, name, sortOrder: i })), tables, orders: [], nextOrder: 104 };
  const seeds: [string, 'open' | 'sent', number, [string, number][]][] = [
    ['t-salon-4', 'sent', 38, [['demo-19', 2], ['demo-7', 2]]],
    ['t-salon-2', 'open', 12, [['demo-11', 1], ['demo-1', 2]]],
    ['t-terraza-1', 'sent', 25, [['demo-21', 1], ['demo-10', 2]]],
  ];
  for (const [tableId, status, minutes, items] of seeds) {
    const t = tables.find(x => x.id === tableId)!;
    const order: DemoOrder = { id: `demo-order-${store.nextOrder}`, orderNumber: store.nextOrder++, status, channel: 'table', tableId, tableLabel: t.label, openedAt: new Date(Date.now() - minutes * 60000).toISOString(), lines: [], payments: [] };
    for (const [productId, quantity] of items) addLine(order, productId, quantity, 0);
    store.orders.push(order);
  }
  save();
  return store;
}

function addLine(order: DemoOrder, productId: string, quantity: number, extrasNet: number) {
  const p = load().products.find(x => x.id === productId && x.active !== false) ?? fail('Producto no disponible');
  order.lines.push({ id: uid('line'), productId, productName: p.name, quantity, lineGross: round((Number(p.priceNet) + extrasNet) * (1 + Number(p.vatRate) / 100) * quantity) });
}

function orderView(o: DemoOrder) { return { ...o, grossTotal: gross(o), paidTotal: paid(o), lineCount: o.lines.length }; }
function tableView(t: DemoTable) { const { mergedFrom, active, ...rest } = t; return { ...rest, spanX: t.spanX ?? 1, spanY: t.spanY ?? 1, joinedCount: mergedFrom?.length ?? 0 }; }
/** "Mesa 1" + "Mesa 2" → "Mesa 1+2" (misma regla que la API). */
function joinedLabel(first: string, second: string) {
  const re = /^(.*?)\s*(\d+(?:\+\d+)*)$/, a = first.match(re), b = second.match(re);
  if (a && b && a[1].toLocaleLowerCase('es') === b[1].toLocaleLowerCase('es')) return `${a[1]}${a[1] ? ' ' : ''}${a[2]}+${b[2]}`;
  return `${first} + ${second}`;
}
function activeFor(tableId: string) { return load().orders.find(o => o.tableId === tableId && (o.status === 'open' || o.status === 'sent')); }

export async function demoRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  await new Promise(r => setTimeout(r, 60));
  const s = load(), method = (init.method || 'GET').toUpperCase(), body = init.body ? JSON.parse(String(init.body)) : {};
  const [route] = path.split('?'), parts = route.split('/').filter(Boolean);
  const result = handle(s, method, parts, body);
  save();
  return JSON.parse(JSON.stringify(result)) as T;
}

function handle(s: Store, method: string, parts: string[], b: any): unknown {
  const [root, id, action] = parts;
  // ---- Carta ----
  if (root === 'menu' && method === 'GET') return s.products.filter(p => p.active !== false);
  if (root === 'categories' && method === 'GET') return s.categories;
  if (root === 'categories' && method === 'POST') {
    const name = String(b.name || '').trim() || fail('Nombre requerido');
    const existing = s.categories.find(c => c.name.toLocaleLowerCase('es') === name.toLocaleLowerCase('es'));
    if (existing) return existing;
    const c = { id: name, name, sortOrder: s.categories.length }; s.categories.push(c); return c;
  }
  if (root === 'products') {
    if (id === 'admin' && method === 'GET') return s.products;
    if (!id && method === 'POST') {
      if (!b.name?.trim() || !Number.isFinite(b.priceNet) || !Number.isFinite(b.vatRate)) fail('Nombre, precio neto e IVA son obligatorios');
      const cat = s.categories.find(c => c.id === b.categoryId);
      const p: DemoProduct = { id: uid('prod'), name: b.name.trim(), description: b.description || null, categoryId: cat?.id ?? null, categoryName: cat?.name ?? null, priceNet: b.priceNet, vatRate: b.vatRate, active: true };
      s.products.push(p); return p;
    }
    const p = s.products.find(x => x.id === id) ?? fail('Producto inexistente');
    if (method === 'PATCH') {
      if (b.name !== undefined) p.name = String(b.name).trim() || fail('El nombre no puede estar vacío');
      if (b.description !== undefined) p.description = b.description;
      if (b.priceNet !== undefined) p.priceNet = b.priceNet;
      if (b.vatRate !== undefined) p.vatRate = b.vatRate;
      if (b.active !== undefined) p.active = b.active;
      if (b.categoryId) { const cat = s.categories.find(c => c.id === b.categoryId); p.categoryId = cat?.id ?? p.categoryId; p.categoryName = cat?.name ?? p.categoryName; }
      return p;
    }
    if (method === 'DELETE') { p.active = false; return { ok: true }; }
  }
  // ---- Mesas ----
  if (root === 'tables') {
    if (!id && method === 'GET') return s.tables.filter(t => t.active !== false).map(t => { const o = activeFor(t.id); return { ...tableView(t), seatsWarning: shapeWarning(t), activeOrder: o ? orderView(o) : null }; });
    const checkLabel = (label: string, self?: string) => { if (s.tables.some(t => t.id !== self && t.active !== false && t.label.toLocaleLowerCase('es') === label.toLocaleLowerCase('es'))) fail('Ya existe una mesa con ese nombre'); };
    if (!id && method === 'POST') {
      const label = String(b.label || '').trim() || fail('El nombre de la mesa es obligatorio'); checkLabel(label);
      const shape = b.shape ?? 'square';
      const seats = b.seats ?? 4;
      if (!Number.isInteger(seats) || seats < 1 || seats > 20) fail('Número de comensales no válido (1-20)');
      const diameterCm = shape === 'round' ? roundDiameter(b.diameterCm ?? 90) : undefined;
      const widthCm = shape === 'square' ? squareSide(b.widthCm ?? 80) : undefined;
      const rect = shape === 'rect' ? rectMeasures(b) : undefined;
      const seatsRecommended = diameterCm ? roundRecommended(diameterCm) : (widthCm ? squareRecommended(widthCm) : (rect?.recommended ?? undefined));
      const t: DemoTable = { id: uid('table'), label, zone: b.zone?.trim() || 'Salón', seats, shape, diameterCm, widthCm, heightCm: rect ? rect.height : widthCm, sidesUsed: rect?.sides, seatsRecommended, seatsWarning: shapeWarning({ seats, shape, seatsRecommended } as DemoTable), posX: b.posX ?? 0, posY: b.posY ?? 0 };
      s.tables.push(t); return tableView(t);
    }
    const t = s.tables.find(x => x.id === id && x.active !== false) ?? fail('Mesa no encontrada');
    if (action === 'join' && method === 'POST') {
      const o = s.tables.find(x => x.id === b.withId && x.id !== t.id && x.active !== false) ?? fail('Elige otra mesa para unir');
      if (o.zone !== t.zone) fail('Solo se pueden unir mesas de la misma zona');
      const [aw, ah, ow, oh] = [t.spanX ?? 1, t.spanY ?? 1, o.spanX ?? 1, o.spanY ?? 1];
      const horizontal = t.posY === o.posY && ah === oh && (t.posX + aw === o.posX || o.posX + ow === t.posX);
      const vertical = t.posX === o.posX && aw === ow && (t.posY + ah === o.posY || o.posY + oh === t.posY);
      if (!horizontal && !vertical) fail('Las mesas deben estar juntas y alineadas para formar una mesa rectangular');
      const ot = activeFor(t.id), oo = activeFor(o.id);
      if (ot && oo) fail('Las dos mesas tienen comanda abierta; cobra una antes de unirlas');
      const ux = Math.min(t.posX, o.posX), uy = Math.min(t.posY, o.posY);
      const [first, second] = t.posX + t.posY <= o.posX + o.posY ? [t, o] : [o, t];
      const label = joinedLabel(first.label, second.label); checkLabel(label, t.id);
      t.mergedFrom = [...(t.mergedFrom ?? []), { joinedId: o.id, label: t.label, seats: t.seats, shape: t.shape, spanX: aw, spanY: ah, offX: t.posX - ux, offY: t.posY - uy, joinedOffX: o.posX - ux, joinedOffY: o.posY - uy }];
      o.active = false;
      Object.assign(t, { label, seats: t.seats + o.seats, shape: 'rect', posX: ux, posY: uy, spanX: horizontal ? aw + ow : aw, spanY: vertical ? ah + oh : ah });
      const order = ot ?? oo; if (order) { order.tableId = t.id; order.tableLabel = label; }
      return tableView(t);
    }
    if (action === 'split' && method === 'POST') {
      const last = t.mergedFrom?.[t.mergedFrom.length - 1] ?? fail('Esta mesa no está unida a otra');
      const o = s.tables.find(x => x.id === last.joinedId);
      if (o) checkLabel(o.label, o.id);
      const [px, py] = [t.posX, t.posY];
      Object.assign(t, { label: last.label, seats: last.seats, shape: last.shape, spanX: last.spanX, spanY: last.spanY, posX: px + last.offX, posY: py + last.offY, mergedFrom: t.mergedFrom!.slice(0, -1) });
      if (o) Object.assign(o, { active: true, zone: t.zone, posX: px + last.joinedOffX, posY: py + last.joinedOffY });
      const order = activeFor(t.id); if (order) order.tableLabel = t.label;
      return tableView(t);
    }
    if (method === 'PATCH') {
      if (b.label !== undefined) { const label = String(b.label).trim() || fail('El nombre de la mesa no puede estar vacío'); checkLabel(label, t.id); t.label = label; const o = activeFor(t.id); if (o) o.tableLabel = label; }
      for (const k of ['zone', 'seats', 'shape', 'posX', 'posY'] as const) if (b[k] !== undefined) (t as any)[k] = b[k];
      if (!Number.isInteger(t.seats) || t.seats < 1 || t.seats > 20) fail('Número de comensales no válido (1-20)');
      const isRound = t.shape === 'round', isSquare = t.shape === 'square', isRect = t.shape === 'rect';
      const rect = isRect ? rectMeasures(b, t) : undefined;
      t.diameterCm = isRound ? roundDiameter(b.diameterCm ?? t.diameterCm ?? 90) : undefined;
      t.widthCm = isSquare ? squareSide(b.widthCm ?? t.widthCm ?? 80) : (rect?.width ?? undefined);
      t.heightCm = isSquare ? t.widthCm : (rect?.height ?? undefined);
      t.sidesUsed = rect?.sides;
      t.seatsRecommended = isRound ? roundRecommended(t.diameterCm!) : (isSquare ? squareRecommended(t.widthCm!) : (rect?.recommended ?? undefined));
      t.seatsWarning = shapeWarning(t);
      return tableView(t);
    }
    if (method === 'DELETE') { if (activeFor(t.id)) fail('La mesa tiene una comanda abierta; cóbrala antes de eliminarla'); s.tables = s.tables.filter(x => x !== t); return { ok: true }; }
  }
  // ---- Comandas ----
  if (root === 'orders') {
    if (!id && method === 'POST') {
      if (b.tableId) {
        const t = s.tables.find(x => x.id === b.tableId && x.active !== false) ?? fail('Mesa no encontrada');
        const existing = activeFor(t.id); if (existing) return { ...orderView(existing), reused: true };
        const o: DemoOrder = { id: uid('order'), orderNumber: s.nextOrder++, status: 'open', channel: 'table', tableId: t.id, tableLabel: t.label, openedAt: new Date().toISOString(), lines: [], payments: [] };
        s.orders.push(o); return { ...orderView(o), reused: false };
      }
      const o: DemoOrder = { id: uid('order'), orderNumber: s.nextOrder++, status: 'open', channel: b.channel || 'counter', tableId: null, tableLabel: b.tableLabel || null, openedAt: new Date().toISOString(), lines: [], payments: [] };
      s.orders.push(o); return { ...orderView(o), reused: false };
    }
    if (id === 'active' && method === 'GET') return s.orders.filter(o => o.status === 'open' || o.status === 'sent').map(orderView);
    const o = s.orders.find(x => x.id === id) ?? fail('Pedido no encontrado');
    if (!action && method === 'GET') return orderView(o);
    if (action === 'lines' && method === 'POST') {
      if (!['open', 'sent'].includes(o.status)) fail('Pedido inexistente, cerrado o no modificable');
      if (!b.productId || !(b.quantity > 0)) fail('Producto y cantidad positiva requeridos');
      addLine(o, b.productId, b.quantity, (b.addedIngredients || []).reduce((sum: number, i: any) => sum + Number(i.extraPriceNet || 0), 0));
      return { ok: true };
    }
    if (action === 'send' && method === 'POST') { if (!['open', 'sent'].includes(o.status)) fail('El pedido no existe o ya fue enviado'); o.status = 'sent'; return { ok: true, orderId: o.id }; }
    if (action === 'payments' && method === 'POST') {
      if (!['cash', 'card'].includes(b.method)) fail('Forma de pago no válida: usa tarjeta (TPV) o efectivo');
      if (!['open', 'sent'].includes(o.status)) fail('Pedido no cobrable');
      const amount = round(Number(b.amount)); if (!(amount > 0)) fail('Importe no válido');
      if (gross(o) <= 0) fail('La comanda no tiene importe que cobrar');
      if (paid(o) + amount > gross(o) + 0.001) fail('El pago supera el total pendiente');
      let cashTendered: number | null = null, changeGiven: number | null = null;
      if (b.method === 'cash') { cashTendered = b.cashTendered == null ? amount : round(Number(b.cashTendered)); if (cashTendered + 0.001 < amount) fail('El efectivo entregado no cubre el importe'); changeGiven = round(cashTendered - amount); }
      o.payments.push({ id: uid('pay'), method: b.method, amount, cashTendered, changeGiven, cardReference: b.method === 'card' ? (b.cardReference?.trim() || null) : null, paidAt: new Date().toISOString() });
      const total = paid(o), closed = total + 0.001 >= gross(o);
      if (closed) o.status = 'paid';
      return { paid: total, remaining: Math.max(0, round(gross(o) - total)), closed, change: changeGiven };
    }
  }
  return fail(`Función no disponible en modo demo (${method} /${parts.join('/')})`);
}
