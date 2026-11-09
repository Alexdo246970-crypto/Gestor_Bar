// Backend simulado en memoria para VITE_DEMO_MODE=true. Replica las reglas principales de la API real
// (una comanda activa por mesa, pagos por tarjeta TPV o efectivo, cierre al completar el total).
import type { Product } from '@bar/contracts';

type DemoProduct = Product & { description?: string | null; categoryName?: string | null; [extra: string]: unknown };
type DemoLine = { id: string; productId: string; productName: string; quantity: number; lineGross: number };
type DemoPayment = { id: string; method: 'cash' | 'card'; amount: number; cashTendered: number | null; changeGiven: number | null; cardReference: string | null; paidAt: string };
type DemoOrder = { id: string; orderNumber: number; status: 'open' | 'sent' | 'paid'; channel: string; tableId: string | null; tableLabel: string | null; openedAt: string; lines: DemoLine[]; payments: DemoPayment[] };
type DemoTable = { id: string; label: string; zone: string; seats: number; shape: 'square' | 'round' | 'bar'; posX: number; posY: number };
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

function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* almacenamiento no disponible */ } }

function load(): Store {
  if (store) return store;
  try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) { store = JSON.parse(raw); return store!; } } catch { /* ignorar */ }
  const categoryNames = [...new Set(seedProducts.map(p => String(p.categoryId)))];
  const tables: DemoTable[] = [
    ...[1, 2, 3, 4, 5, 6].map((n, i) => ({ id: `t-salon-${n}`, label: `Mesa ${n}`, zone: 'Salón', seats: n === 5 || n === 6 ? 6 : 4, shape: (n % 3 === 0 ? 'round' : 'square') as DemoTable['shape'], posX: 1 + (i % 3) * 2, posY: 1 + Math.floor(i / 3) * 2 })),
    ...[1, 2, 3, 4].map((n, i) => ({ id: `t-terraza-${n}`, label: `Terraza ${n}`, zone: 'Terraza', seats: 2, shape: 'round' as const, posX: 1 + i * 2, posY: 1 })),
    ...[1, 2, 3].map((n, i) => ({ id: `t-barra-${n}`, label: `Barra ${n}`, zone: 'Barra', seats: 1, shape: 'bar' as const, posX: 1 + i, posY: 1 })),
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
    if (!id && method === 'GET') return s.tables.map(t => { const o = activeFor(t.id); return { ...t, activeOrder: o ? orderView(o) : null }; });
    const checkLabel = (label: string, self?: string) => { if (s.tables.some(t => t.id !== self && t.label.toLocaleLowerCase('es') === label.toLocaleLowerCase('es'))) fail('Ya existe una mesa con ese nombre'); };
    if (!id && method === 'POST') {
      const label = String(b.label || '').trim() || fail('El nombre de la mesa es obligatorio'); checkLabel(label);
      const t: DemoTable = { id: uid('table'), label, zone: b.zone?.trim() || 'Salón', seats: b.seats ?? 4, shape: b.shape ?? 'square', posX: b.posX ?? 0, posY: b.posY ?? 0 };
      s.tables.push(t); return t;
    }
    const t = s.tables.find(x => x.id === id) ?? fail('Mesa no encontrada');
    if (method === 'PATCH') {
      if (b.label !== undefined) { const label = String(b.label).trim() || fail('El nombre de la mesa no puede estar vacío'); checkLabel(label, t.id); t.label = label; const o = activeFor(t.id); if (o) o.tableLabel = label; }
      for (const k of ['zone', 'seats', 'shape', 'posX', 'posY'] as const) if (b[k] !== undefined) (t as any)[k] = b[k];
      return t;
    }
    if (method === 'DELETE') { if (activeFor(t.id)) fail('La mesa tiene una comanda abierta; cóbrala antes de eliminarla'); s.tables = s.tables.filter(x => x !== t); return { ok: true }; }
  }
  // ---- Comandas ----
  if (root === 'orders') {
    if (!id && method === 'POST') {
      if (b.tableId) {
        const t = s.tables.find(x => x.id === b.tableId) ?? fail('Mesa no encontrada');
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
