// Backend simulado en memoria para VITE_DEMO_MODE=true. Replica las reglas principales de la API real
// (una comanda activa por mesa, pagos por tarjeta TPV o efectivo, cierre al completar el total).
import type { Product } from '@bar/contracts';
import { DEFAULT_COLS, DEFAULT_ROWS, Rect, freeSpot, joinedRect } from './floorLayout';

type DemoProduct = Product & { description?: string | null; categoryName?: string | null; [extra: string]: unknown };
type KitchenStatus = 'received' | 'preparing' | 'ready';
type DemoLine = { id: string; productId: string; productName: string; quantity: number; lineGross: number; kitchenStatus?: KitchenStatus; modifications?: { action: 'remove' | 'add'; ingredient: string }[]; cancelledAt?: string; cancellationReason?: string; addedBy?: string };
type DemoPayment = { id: string; method: 'cash' | 'card'; amount: number; cashTendered: number | null; changeGiven: number | null; cardReference: string | null; paidAt: string };
type DemoOrder = { id: string; orderNumber: number; status: 'open' | 'sent' | 'paid'; channel: string; tableId: string | null; tableLabel: string | null; openedAt: string; lines: DemoLine[]; payments: DemoPayment[] };
type JoinSnapshot = { joinedId: string; joinedZone?: string; widthCm?: number; heightCm?: number; diameterCm?: number; label: string; seats: number; shape: DemoTable['shape']; spanX: number; spanY: number; offX: number; offY: number; joinedOffX: number; joinedOffY: number };
type DemoTable = { id: string; label: string; zone: string; seats: number; shape: 'square' | 'round' | 'bar' | 'rect'; posX: number; posY: number; diameterCm?: number; widthCm?: number; heightCm?: number; sidesUsed?: string[]; seatsRecommended?: number; seatsWarning?: boolean; spanX?: number; spanY?: number; mergedFrom?: JoinSnapshot[]; active?: boolean };
type DemoDailyMenu = { id: string; date: string; name: string; priceNet: number; vatRate: number; products: { id: string; name: string }[] };
type DemoIngredient = { id: string; name: string; unit: string; quantityPerUnit?: number };
type DemoRoom = { id: string; name: string; widthCm: number; heightCm: number; sortOrder: number; active: boolean };
type Store = { accounting?: any; qrSettings?: { approvalRequired: boolean; maxOrderLines: number; cooldownSeconds: number }; kitchenSettings?: Record<string, unknown>; rooms?: DemoRoom[]; products: DemoProduct[]; categories: { id: string; name: string; sortOrder: number }[]; tables: DemoTable[]; orders: DemoOrder[]; dailyMenus: DemoDailyMenu[]; staff: { id: string; email: string; fullName: string; role: string; active: boolean }[]; activity: { id: string; eventType: string; targetId: string | null; details: Record<string, unknown>; createdAt: string; actorName: string | null }[]; tenant: { name: string; slug: string; timezone: string; currency: string }; nextOrder: number };

const STORAGE_KEY = 'barraos-demo-v2';
let seedProducts: DemoProduct[] = [];
let seedIngredients: DemoIngredient[] = [];
let demoExtraPrices: Record<string, Record<string, number>> = {};
let store: Store | null = null;

export function seedDemoProducts(products: Product[], ingredients: DemoIngredient[] = [], extraPrices: Record<string, Record<string, number>> = {}) { seedProducts = products as DemoProduct[]; seedIngredients = ingredients; demoExtraPrices = extraPrices; }

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const round = (n: number) => Math.round(n * 100) / 100;
const gross = (o: DemoOrder) => round(o.lines.filter(l => !l.cancelledAt).reduce((s, l) => s + l.lineGross, 0));
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
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      store = JSON.parse(raw);
      store!.dailyMenus ||= [];
      store!.staff ||= [];
      store!.staff.forEach(x => x.active ??= true);
      store!.activity ||= [];
      store!.tenant ||= { name: 'La Esquina', slug: 'la-esquina', timezone: 'Europe/Madrid', currency: 'EUR' };
      store!.tables.forEach(t => { t.spanX ??= 1; t.spanY ??= 1; });
      return store!;
    }
  } catch { /* ignorar */ }
  const categoryNames = [...new Set(seedProducts.map(p => String(p.categoryId)))];
  const tables: DemoTable[] = [
    ...[1, 2, 3, 4, 5, 6].map((n, i) => {
      const shape = (n % 3 === 0 ? 'round' : 'square') as DemoTable['shape'];
      const seats = n === 5 || n === 6 ? 6 : 4;
      const diameterCm = shape === 'round' ? (seats <= 4 ? 90 : 120) : undefined;
      const widthCm = shape === 'square' ? 80 : undefined;
      return { id: `t-salon-${n}`, label: `Mesa ${n}`, zone: 'Salón', seats, shape, diameterCm, widthCm, heightCm: widthCm, seatsRecommended: diameterCm ? roundRecommended(diameterCm) : (widthCm ? squareRecommended(widthCm) : undefined), posX: 1 + (i % 3) * 2, posY: 1 + Math.floor(i / 3) * 2 };
    }),
    ...[1, 2, 3, 4].map((n, i) => ({ id: `t-terraza-${n}`, label: `Terraza ${n}`, zone: 'Terraza', seats: 2, shape: 'round' as const, diameterCm: 90, seatsRecommended: 4, posX: 1 + i * 2, posY: 1 })),
    ...[1, 2, 3].map((n, i) => ({ id: `t-barra-${n}`, label: `Barra ${n}`, zone: 'Barra', seats: 1, shape: 'rect' as const, widthCm: 120, heightCm: 60, sidesUsed: ['long1'], seatsRecommended: 2, posX: 1 + i, posY: 1 })),
  ];
  store = { products: seedProducts.map(p => ({ ...p, categoryName: String(p.categoryId) })), categories: categoryNames.map((name, i) => ({ id: name, name, sortOrder: i })), tables, orders: [], dailyMenus: [], staff: [], activity: [], tenant: { name: 'La Esquina', slug: 'la-esquina', timezone: 'Europe/Madrid', currency: 'EUR' }, nextOrder: 104 };
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

function addLine(order: DemoOrder, productId: string, quantity: number, extrasNet: number, removeIds: string[] = [], addedIds: string[] = []) {
  const p = load().products.find(x => x.id === productId && x.active !== false) ?? fail('Producto no disponible');
  const name = (id: string) => seedIngredients.find(i => i.id === id)?.name ?? id;
  const modifications = [...removeIds.map(id => ({ action: 'remove' as const, ingredient: name(id) })), ...addedIds.map(id => ({ action: 'add' as const, ingredient: name(id) }))];
  order.lines.push({ id: uid('line'), productId, productName: p.name, quantity, lineGross: round((Number(p.priceNet) + extrasNet) * (1 + Number(p.vatRate) / 100) * quantity), kitchenStatus: 'received', modifications });
}
/** Cocina ve las comandas enviadas y las cobradas en el TPV en las últimas 12 h mientras tengan platos sin terminar. */
const kitchenVisible = (o: DemoOrder) => o.status === 'sent' || (o.status === 'paid' && Date.now() - new Date(o.openedAt).getTime() < 12 * 3600000);
function stationOf(productId: string) {
  const p = load().products.find(x => x.id === productId), key = String(p?.categoryName ?? p?.categoryId ?? '').toLocaleLowerCase('es');
  return key.includes('bebida') || key.includes('café') || key.includes('cafe') ? 'bar' : 'kitchen';
}

function orderView(o: DemoOrder) { return { ...o, grossTotal: gross(o), paidTotal: paid(o), lineCount: o.lines.filter(l => !l.cancelledAt).length }; }
function tableView(t: DemoTable) { const { mergedFrom, active, ...rest } = t; return { ...rest, spanX: t.spanX ?? 1, spanY: t.spanY ?? 1, joinedCount: mergedFrom?.length ?? 0 }; }
/** "Mesa 1" + "Mesa 2" → "Mesa 1+2" (misma regla que la API). */
/** Casillas de 40 cm que ocupa una mesa (misma regla que la API y el plano). */
function footprint(t: { posX: number; posY: number; shape: string; spanX?: number; spanY?: number; diameterCm?: number; widthCm?: number; heightCm?: number; mergedFrom?: unknown[] }): Rect {
  const sx = t.spanX ?? 1, sy = t.spanY ?? 1, joined = (t.mergedFrom?.length ?? 0) > 0 || sx > 1 || sy > 1;
  const wCm = joined ? sx * 40 : t.shape === 'round' ? t.diameterCm || 90 : t.widthCm || (t.shape === 'bar' ? 120 : 80);
  const hCm = joined ? sy * 40 : t.shape === 'round' ? t.diameterCm || 90 : t.heightCm || (t.shape === 'bar' ? 60 : 80);
  return { x: t.posX, y: t.posY, w: Math.max(1, Math.round(wCm / 40), sx), h: Math.max(1, Math.round(hCm / 40), sy) };
}
function joinedLabel(first: string, second: string) {
  const re = /^(.*?)\s*(\d+(?:\+\d+)*)$/, a = first.match(re), b = second.match(re);
  if (a && b && a[1].toLocaleLowerCase('es') === b[1].toLocaleLowerCase('es')) return `${a[1]}${a[1] ? ' ' : ''}${a[2]}+${b[2]}`;
  return `${first} + ${second}`;
}
/** Salas del modo demo: se crean a partir de las zonas de las mesas la primera vez (8 × 5 m). */
function demoRooms(s: Store) {
  if (!s.rooms) s.rooms = [...new Set(s.tables.filter(t => t.active !== false).map(t => t.zone))].map((name, i) => ({ id: `room-${i + 1}`, name, widthCm: 800, heightCm: 500, sortOrder: i, active: true }));
  return s.rooms;
}
/** Tamaño de la sala en casillas de 40 cm (8 × 5 si la zona no tiene sala). */
function roomGrid(s: Store, zone: string) {
  const r = demoRooms(s).find(x => x.active && x.name.toLocaleLowerCase('es') === zone.toLocaleLowerCase('es'));
  return r ? { room: r, cols: Math.ceil(r.widthCm / 40), rows: Math.ceil(r.heightCm / 40) } : { room: undefined, cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
}
/** Si una mesa no cabe, la sala crece hasta que quepa (máximo 100 m). */
function growRoom(s: Store, zone: string, r: Rect) {
  const g = roomGrid(s, zone); if (!g.room) return;
  g.room.widthCm = Math.min(10000, Math.max(g.room.widthCm, (r.x + r.w) * 40));
  g.room.heightCm = Math.min(10000, Math.max(g.room.heightCm, (r.y + r.h) * 40));
}
function activeFor(tableId: string) { return load().orders.find(o => o.tableId === tableId && (o.status === 'open' || o.status === 'sent')); }

export async function demoRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  await new Promise(r => setTimeout(r, 60));
  const s = load(), method = (init.method || 'GET').toUpperCase(), body = init.body ? JSON.parse(String(init.body)) : {};
  const [route, queryString = ''] = path.split('?'), parts = route.split('/').filter(Boolean);
  const result = handle(s, method, parts, body, new URLSearchParams(queryString));
  save();
  return JSON.parse(JSON.stringify(result)) as T;
}

function handle(s: Store, method: string, parts: string[], b: any, query: URLSearchParams): unknown {
  const [root, id, action] = parts;
  // Accounting data in demo mode is persisted in the same browser store as orders.
  const a = s.accounting ||= { ledger: [], accounts: [], commitments: [], employees: [], salaries: [], taxes: [], lossSettings: 3, losses: [], taxSettings: { frequency: 'quarterly', vatRegime: 'general', dueDay: 20, thresholdPct: 3 }, taxPeriods: [] };
  if (root === 'ledger') {
    if (id === 'categories' && method === 'GET') return [...new Set(a.ledger.map((x: any) => x.category))];
    if (id === 'csv') return '';
    if (!id && method === 'GET') {
      const lines = a.ledger.filter((x: any) => (!query.get('from') || x.date >= query.get('from')!) && (!query.get('to') || x.date <= query.get('to')!) && (!query.get('category') || x.category === query.get('category')) && (!query.get('account') || x.account === query.get('account'))).sort((x: any, y: any) => y.date.localeCompare(x.date));
      const total = (type: string, field: string) => round(lines.filter((x: any) => x.type === type).reduce((n: number, x: any) => n + x[field], 0));
      return { lines, total: lines.length, page: 1, pageSize: 100, totals: { incomeNet: total('income','amountNet'), incomeVat: total('income','vat'), incomeTotal: total('income','total'), expenseNet: total('expense','amountNet'), expenseVat: total('expense','vat'), expenseTotal: total('expense','total') }, byCategory: [...new Set<string>(lines.map((x: any) => `${x.type}|${x.category}`))].map(key => { const [type, category] = key.split('|'); return { type, category, total: round(lines.filter((x: any) => x.type === type && x.category === category).reduce((n: number, x: any) => n + x.total, 0)) }; }) };
    }
    if (!id && method === 'POST') { const net = Number(b.amountNet), vat = Number(b.vat || 0); if (!b.date || !b.category || !(net > 0)) fail('Datos de apunte no válidos'); const line = { id: uid('ledger'), date: b.date, type: b.type === 'income' ? 'income' : 'expense', category: String(b.category), account: b.account || 'cash', amountNet: net, vat, total: round(net + vat), sourceType: 'manual', notes: b.notes || '' }; a.ledger.push(line); return line; }
  }
  if (root === 'treasury') {
    if (id === 'summary' && method === 'GET') { const accounts = a.accounts.map((x: any) => ({ ...x, balance: round(x.initialBalance + a.ledger.filter((l: any) => l.account === x.kind).reduce((n: number, l: any) => n + (l.type === 'income' ? l.total : -l.total), 0)) })); const commitments = a.commitments.filter((x: any) => !x.paid); const total = round(accounts.reduce((n: number, x: any) => n + x.balance, 0)); return { accounts, total, commitments, committed: round(commitments.reduce((n: number, x: any) => n + x.amount, 0)), availableReal: round(total - commitments.reduce((n: number, x: any) => n + x.amount, 0)), evolution: a.ledger.slice(-30).map((x: any) => ({ date: x.date, account: x.account, income: x.type === 'income' ? x.total : 0, expense: x.type === 'expense' ? x.total : 0 })), cashClosure: null }; }
    if (id === 'accounts' && method === 'POST') { if (a.accounts.some((x: any) => x.kind === b.kind)) fail('Ya existe una cuenta de este tipo'); const row = { id: uid('account'), kind: b.kind, name: b.name, initialBalance: Number(b.initialBalance || 0), iban: b.iban || null }; a.accounts.push(row); return row; }
    if (id === 'commitments' && action === 'sync' && method === 'POST') return { ok: true };
    if (id === 'commitments' && !action && method === 'POST') { const row = { id: uid('commitment'), description: b.description, amount: Number(b.amount), dueDate: b.dueDate || null, account: b.account || 'bank', paid: false }; a.commitments.push(row); return row; }
    if (id === 'transfers' && method === 'POST') { if (b.fromId === b.toId || !(Number(b.amount) > 0)) fail('Traspaso no válido'); const from = a.accounts.find((x: any) => x.id === b.fromId), to = a.accounts.find((x: any) => x.id === b.toId); if (!from || !to) fail('Selecciona dos cuentas'); a.ledger.push({ id: uid('transfer'), date: b.date || new Date().toLocaleDateString('en-CA'), type: 'expense', category: `Traspaso a ${to.name}`, account: from.kind, amountNet: Number(b.amount), vat: 0, total: Number(b.amount), sourceType: 'transfer', notes: '' }, { id: uid('transfer'), date: b.date || new Date().toLocaleDateString('en-CA'), type: 'income', category: `Traspaso desde ${from.name}`, account: to.kind, amountNet: Number(b.amount), vat: 0, total: Number(b.amount), sourceType: 'transfer', notes: '' }); return { ok: true }; }
    if (id === 'commitments' && action && method === 'POST') { const item = a.commitments.find((x: any) => x.id === action) || fail('Compromiso no encontrado'); item.paid = true; return { ok: true }; }
  }
  if (root === 'employees') { if (!id && method === 'GET') return a.employees; if (!id && method === 'POST') { const row = { id: uid('employee'), name: b.name, taxId: b.taxId || null, position: b.position || null, leftAt: null, paymentAccount: b.paymentAccount || null }; a.employees.push(row); return row; } }
  if (root === 'salaries') {
    if (!id && method === 'GET') { const lines = a.salaries.filter((x: any) => x.month === query.get('month')).map((x: any) => ({ ...x, employeeName: a.employees.find((e: any) => e.id === x.employeeId)?.name || 'Empleado' })); return { lines, totals: { gross: round(lines.reduce((n: number,x: any)=>n+x.gross,0)), net: round(lines.reduce((n: number,x: any)=>n+x.net,0)), socialSecurityCompany: round(lines.reduce((n: number,x: any)=>n+x.socialSecurityCompany,0)), cost: round(lines.reduce((n: number,x: any)=>n+x.gross+x.socialSecurityCompany,0)) } }; }
    if (!id && method === 'POST') { const row = { id: uid('salary'), month: b.month, employeeId: b.employeeId, gross: Number(b.gross), socialSecurityCompany: Number(b.socialSecurityCompany||0), socialSecurityWorker: Number(b.socialSecurityWorker||0), irpfWithheld: Number(b.irpfWithheld||0), otherConcepts: Number(b.otherConcepts||0), net: round(Number(b.gross)-Number(b.socialSecurityWorker||0)-Number(b.irpfWithheld||0)+Number(b.otherConcepts||0)), status: 'draft', paymentDate: b.paymentDate || null, paidAt: null }; a.salaries.push(row); return row; }
    if (id && method === 'POST') { const row = a.salaries.find((x: any) => x.id === id) || fail('Nómina no encontrada'); row.status = action === 'confirm' ? 'confirmed' : action === 'pay' ? 'paid' : action === 'void' ? 'void' : row.status; if (action === 'pay') row.paidAt = b.paidAt || new Date().toLocaleDateString('en-CA'); return row; }
  }
  if (root === 'tax') {
    if (id === 'settings' && method === 'GET') return a.taxSettings;
    if (id === 'settings' && method === 'POST' || id === 'settings' && method === 'PATCH') { a.taxSettings = { ...a.taxSettings, ...b }; return a.taxSettings; }
    if (id === 'other' && !action && method === 'GET') return a.taxes;
    if (id === 'other' && !action && method === 'POST') { const row = { id: uid('tax'), name: b.name, amount: Number(b.amount), period: b.period || null, dueDate: b.dueDate || null, reference: b.reference || null, paid: false }; a.taxes.push(row); return row; }
    if (id === 'other' && action && method === 'POST') { const row = a.taxes.find((x: any) => x.id === action) || fail('Impuesto no encontrado'); row.paid = true; a.ledger.push({ id: uid('ledger'), date: row.dueDate || new Date().toLocaleDateString('en-CA'), type: 'expense', category: row.name, account: 'bank', amountNet: row.amount, vat: 0, total: row.amount, sourceType: 'tax', notes: row.reference || '' }); return row; }
    if (id === 'periods' && action === 'generate' && method === 'POST') { const count = a.taxSettings.frequency === 'monthly' ? 12 : 4; a.taxPeriods = Array.from({length: count}, (_,i) => { const month = a.taxSettings.frequency === 'monthly' ? i + 1 : i * 3 + 1; const endMonth = Math.min(month + (a.taxSettings.frequency === 'monthly' ? 0 : 2),12); return { id: `vat-${b.year}-${i+1}`, periodKey: a.taxSettings.frequency === 'monthly' ? `${b.year}-${String(month).padStart(2,'0')}` : `${b.year}-T${i+1}`, startDate: `${b.year}-${String(month).padStart(2,'0')}-01`, endDate: new Date(b.year,endMonth,0).toLocaleDateString('en-CA'), dueDate: `${b.year}-${String(Math.min(endMonth+1,12)).padStart(2,'0')}-${String(a.taxSettings.dueDay).padStart(2,'0')}`, outputVat: 0, inputVat: 0, roundingAdjustment: 0, result: 0, status: 'open', notes: null }; }); return a.taxPeriods; }
    if (id === 'periods' && !action && method === 'GET') return a.taxPeriods.filter((x: any) => x.startDate.startsWith(String(query.get('year') || new Date().getFullYear())));
    if (id === 'alerts' && method === 'GET') return { periods: [], otherTaxes: a.taxes.filter((x: any) => !x.paid && x.dueDate).map((x: any) => ({ name: x.name, amount: x.amount, dueDate: x.dueDate })) };
    if (id === 'periods' && action && method === 'GET') return { ...a.taxPeriods.find((x: any) => x.id === action), entries: [], currentResult: 0, difference: null };
    if (id === 'periods' && action && method === 'POST') { const p = a.taxPeriods.find((x: any) => x.id === action) || fail('Periodo no encontrado'); p.status = parts[3] === 'close' ? 'filed' : 'paid'; return p; }
  }
  if (root === 'loss') {
    if (id === 'settings' && method === 'POST') { a.lossSettings = Number(b.thresholdPct); return { thresholdPct: a.lossSettings }; }
    if (!id && method === 'GET') return { thresholdPct: a.lossSettings };
  }
  if (root === 'losses') {
    if (id === 'invitations' && method === 'POST') { a.losses.push({ id: uid('loss'), date: new Date().toLocaleDateString('en-CA'), reason: b.reason || 'invitation', amount: Number(b.amount), productName: b.description, employeeName: 'Admin de demostración', sourceType: 'invitation', notes: b.notes || '' }); return { ok: true }; }
  }
  if (root === 'reports' && id === 'losses' && method === 'GET') { const lines = a.losses.filter((x: any) => (!query.get('from') || x.date >= query.get('from')!) && (!query.get('to') || x.date <= query.get('to')!)); const total = round(lines.reduce((n: number,x: any)=>n+x.amount,0)); const group = (key: string, name: string) => [...new Set(lines.map((x: any)=>x[key]))].map((value: any)=>({[name]:value,amount:round(lines.filter((x: any)=>x[key]===value).reduce((n: number,x: any)=>n+x.amount,0))})); return { from: query.get('from'), to: query.get('to'), total, lines: lines.map((x: any)=>({...x,signedAmount:-x.amount})), byReason: group('reason','reason'), byProduct: group('productName','product'), byEmployee: group('employeeName','employee'), salesNet: 0, percentOfSales: null, thresholdPct: a.lossSettings, alert: false, reasons: [] }; }
  if (root === 'reports' && id === 'income-statement' && method === 'GET') { const rows=a.ledger.filter((x: any)=>x.date>=(query.get('from')||'0000')&&x.date<=(query.get('to')||'9999')&&x.sourceType!=='transfer'); const sales=round(rows.filter((x: any)=>x.type==='income').reduce((n: number,x: any)=>n+x.amountNet,0)); const expenses=round(rows.filter((x: any)=>x.type==='expense').reduce((n: number,x: any)=>n+x.amountNet,0)); const result=round(sales-expenses); const lines = [{key:'sales',label:'Ingresos',amount:sales,formula:'Ingresos registrados en el libro',sources:['manual','order_payment'],weight:null},{key:'gross',label:'Margen bruto',amount:result,formula:'Ingresos − gastos registrados',sources:['manual','order_payment'],weight:null},{key:'ebitda',label:'EBITDA',amount:result,formula:'Margen operativo demo',sources:[],weight:null},{key:'net',label:'Resultado neto',amount:result,formula:'Resultado operativo − impuestos',sources:[],weight:null,highlight:true}]; return { from: query.get('from'), to: query.get('to'), lines, comparison:{previous:{from:'',to:'',net:0,grossMargin:0},previousYear:{from:'',to:'',net:0,grossMargin:0}}, ytd:{net:result,grossMargin:result}, indicators:{grossMarginPct:sales?round(result/sales*100):null,personalPct:null,avgTicket:0,breakEvenSales:null}, ledger:rows, expenseBreakdown:[] }; }
  if (root === 'reports' && id === 'amortizations' && method === 'GET') return a.amortizations ||= [];
  if (root === 'reports' && id === 'amortizations' && method === 'POST') { const row = { id: uid('amortization'), ...b, active: true }; (a.amortizations ||= []).push(row); return row; }
  if (root === 'reports' && id === 'amortizations' && action && method === 'DELETE') { a.amortizations = (a.amortizations || []).map((x: any)=>x.id===action?{...x,active:false}:x); return { ok:true }; }
  if (root === 'purchases') {
    a.purchases ||= [];
    if (!id && method === 'GET') { const rows = a.purchases.filter((x: any) => (!query.get('from') || x.invoiceDate >= query.get('from')!) && (!query.get('to') || x.invoiceDate <= query.get('to')!) && (!query.get('status') || x.status === query.get('status') || x.paymentStatus === query.get('status'))); return { lines: rows, totals: { gross: round(rows.reduce((n: number,x: any)=>n+x.grossTotal,0)), paid: round(rows.reduce((n: number,x: any)=>n+x.paidAmount,0)), pending: round(rows.reduce((n: number,x: any)=>n+x.pendingAmount,0)) } }; }
    if (!id && method === 'POST') { const lines = (b.lines || []).map((x: any) => { const net=Number(x.quantity)*Number(x.unitPriceNet), vat=round(net*Number(x.vatRate)/100); return { id:uid('purchase-line'),description:x.description||null,ingredientName:null,quantity:Number(x.quantity),unitPriceNet:Number(x.unitPriceNet),vatRate:Number(x.vatRate),lineGross:round(net+vat) }; }); const netTotal=round(lines.reduce((n: number,x: any)=>n+x.quantity*x.unitPriceNet,0)); const grossTotal=round(lines.reduce((n: number,x: any)=>n+x.lineGross,0)); const row={ id:uid('purchase'), invoiceNumber:b.invoiceNumber||null, invoiceDate:b.invoiceDate, dueDate:b.dueDate||null,status:'draft',paymentStatus:'pending',paidAmount:0,netTotal,grossTotal,pendingAmount:grossTotal,vatDeductible:b.vatDeductible!==false,supplierName:null,lineCount:lines.length,notes:b.notes||null,lines,payments:[] }; a.purchases.push(row); return row; }
    if (id && action === 'receive' && method === 'POST') { const row=a.purchases.find((x: any)=>x.id===id)||fail('Factura no encontrada'); if (row.status !== 'received') { row.status='received'; a.ledger.push({ id: uid('ledger'), date: row.invoiceDate, type: 'expense', category: 'Compras a proveedores', account: 'bank', amountNet: row.netTotal, vat: round(row.grossTotal-row.netTotal), total: row.grossTotal, sourceType: 'purchase', notes: row.invoiceNumber || '' }); } return row; }
    if (id && action === 'payments' && method === 'POST') { const row=a.purchases.find((x: any)=>x.id===id)||fail('Factura no encontrada'); const amount=Number(b.amount); if (!(amount>0) || amount>row.pendingAmount) fail('Importe de pago no válido'); row.payments.push({id:uid('payment'),amount,method:'transfer',account:'bank',reference:null,paidAt:new Date().toISOString()}); row.paidAmount=round(row.paidAmount+amount); row.pendingAmount=round(row.grossTotal-row.paidAmount); row.paymentStatus=row.pendingAmount===0?'paid':'partial'; return row; }
    if (id && method === 'GET') return a.purchases.find((x: any)=>x.id===id)||fail('Factura no encontrada');
  }
  if (root === 'auth' && id === 'platform' && parts[2] === 'tenants' && method === 'GET') {
    return [{ id: 'demo-tenant', slug: s.tenant.slug, name: s.tenant.name, timezone: s.tenant.timezone, currency: s.tenant.currency }];
  }
  if (root === 'auth' && id === 'platform' && parts[2] === 'tenants' && parts[3] === 'demo-tenant' && method === 'POST') {
    return { user: { id: 'demo-user', email: 'admin-demo@barraos.local', fullName: 'Admin de demostración', tenantId: 'demo-tenant', tenantName: s.tenant.name, role: 'admin', platformAdmin: true } };
  }
  if (root === 'auth' && id === 'platform' && parts[2] === 'panel' && method === 'POST') return { ok: true };
  if (root === 'activity' && method === 'GET') return s.activity;
  if (root === 'tenant' && method === 'GET') return s.tenant;
  if (root === 'tenant' && method === 'PATCH') { if (b.name !== undefined) s.tenant.name = String(b.name).trim(); if (b.timezone !== undefined) s.tenant.timezone = String(b.timezone).trim(); return s.tenant; }
  if (root === 'staff' && method === 'GET') return s.staff;
  if (root === 'staff' && method === 'POST') {
    if (!b.email || !b.fullName || String(b.password || '').length < 12 || !['admin', 'owner', 'manager', 'waiter', 'temporary_waiter', 'cashier'].includes(b.role)) fail('Datos de perfil no válidos');
    const member = { id: uid('staff'), email: String(b.email).toLowerCase(), fullName: String(b.fullName).trim(), role: b.role, active: true };
    s.staff.push(member);
    s.activity.unshift({ id: uid('activity'), eventType: 'staff.created', targetId: member.id, details: { email: member.email, role: member.role }, createdAt: new Date().toISOString(), actorName: 'Admin de demostración' });
    return member;
  }
  if (root === 'staff' && id && method === 'PATCH') {
    const member = s.staff.find(x => x.id === id) || fail('Usuario no encontrado');
    if (b.role) member.role = b.role;
    if (b.active !== undefined) member.active = Boolean(b.active);
    s.activity.unshift({ id: uid('activity'), eventType: 'staff.updated', targetId: id, details: { role: member.role, active: member.active }, createdAt: new Date().toISOString(), actorName: 'Admin de demostración' });
    return member;
  }
  if (root === 'staff' && id && method === 'DELETE') {
    const member = s.staff.find(x => x.id === id) || fail('Usuario no encontrado');
    member.active = false;
    s.activity.unshift({ id: uid('activity'), eventType: 'staff.deactivated', targetId: id, details: { role: member.role }, createdAt: new Date().toISOString(), actorName: 'Admin de demostración' });
    return { ok: true };
  }
  if (root === 'inventory' && id === 'ingredients' && method === 'GET') return seedIngredients.map((i, index) => ({ ...i, currentStock: 18 + index, minStock: 5, unitCost: 0.01, stockValue: (18 + index) * 0.01, packageLabel: 'Paquete', packageSize: 1000, packagePriceNet: 10, defaultVatRate: 10 }));
  if (root === 'products' && action === 'modifiers' && method === 'GET') {
    const product = s.products.find(x => x.id === id) || fail('Producto inexistente'), base = (((product as any).ingredients || []) as DemoIngredient[]).map(x => ({ ...x, quantityPerUnit: Number(x.quantityPerUnit || 1) })), allowed = ((product as any).allowedExtraIds || []) as string[], prices = (product as any).allowedExtraPrices || demoExtraPrices[id] || {};
    return { base, available: allowed.map(ingredientId => ({ ...seedIngredients.find(x => x.id === ingredientId), extraPriceNet: Number(prices[ingredientId] || 0) })).filter((x: any) => x.id) };
  }
  if (root === 'recipes' && id && method === 'POST') {
    const product = s.products.find(x => x.id === id) || fail('Producto inexistente'), base = Array.isArray(b.ingredients) ? b.ingredients : [], allowed = Array.isArray(b.allowedIngredients) ? b.allowedIngredients : [];
    (product as any).ingredients = base.map((x: any) => { const ingredient = seedIngredients.find(i => i.id === x.ingredientId) || fail('Ingrediente no disponible'); return { ...ingredient, quantityPerUnit: Number(x.quantity) }; });
    (product as any).allowedExtraIds = allowed.map((x: any) => x.ingredientId);
    (product as any).allowedExtraPrices = Object.fromEntries(allowed.map((x: any) => [x.ingredientId, Number(x.extraPriceNet)]));
    return { ok: true };
  }
  // ---- Carta ----
  if (root === 'menu' && method === 'GET') { const today = new Date().toLocaleDateString('en-CA'); return s.products.filter(p => p.active !== false && (!p.availableFrom || String(p.availableFrom).slice(0, 10) <= today) && (!p.availableTo || String(p.availableTo).slice(0, 10) >= today)); }
  if (root === 'daily-menus') {
    if (method === 'GET') { const date = query.get('date') || new Date().toLocaleDateString('en-CA'); return s.dailyMenus.filter(m => m.date === date); }
    if (method === 'POST') { if (!b.name || !b.date || !Number.isFinite(b.priceNet) || !Number.isFinite(b.vatRate)) fail('Nombre, fecha y precio válidos requeridos'); const items = (b.productIds || []).map((id: string) => { const p = s.products.find(x => x.id === id); if (!p) return fail('Producto de menú no disponible'); return { id: p.id, name: p.name }; }); const menu = { id: uid('daily-menu'), date: b.date, name: String(b.name).trim(), priceNet: b.priceNet, vatRate: b.vatRate, products: items }; s.dailyMenus.push(menu); return { id: menu.id }; }
  }
  if (root === 'categories' && method === 'GET') return s.categories;
  if (root === 'categories' && method === 'POST') {
    const name = String(b.name || '').trim() || fail('Nombre requerido');
    const existing = s.categories.find(c => c.name.toLocaleLowerCase('es') === name.toLocaleLowerCase('es'));
    if (existing) return existing;
    const c = { id: name, name, sortOrder: s.categories.length };
    s.categories.push(c);
    return c;
  }
  if (root === 'products') {
    if (id === 'admin' && method === 'GET') return s.products;
    if (!id && method === 'POST') {
      if (!b.name?.trim() || !Number.isFinite(b.priceNet) || !Number.isFinite(b.vatRate)) fail('Nombre, precio neto e IVA son obligatorios');
      const cat = s.categories.find(c => c.id === b.categoryId);
      const p: DemoProduct = { id: uid('prod'), name: b.name.trim(), description: b.description || null, categoryId: cat?.id ?? null, categoryName: cat?.name ?? null, priceNet: b.priceNet, vatRate: b.vatRate, active: true, availableFrom: b.availableFrom || null, availableTo: b.availableTo || null };
      s.products.push(p);
      return p;
    }
    const p = s.products.find(x => x.id === id) ?? fail('Producto inexistente');
    if (method === 'PATCH') {
      if (b.name !== undefined) p.name = String(b.name).trim() || fail('El nombre no puede estar vacío');
      if (b.description !== undefined) p.description = b.description;
      if (b.priceNet !== undefined) p.priceNet = b.priceNet;
      if (b.vatRate !== undefined) p.vatRate = b.vatRate;
      if (b.availableFrom !== undefined) p.availableFrom = b.availableFrom;
      if (b.availableTo !== undefined) p.availableTo = b.availableTo;
      if (b.active !== undefined) p.active = b.active;
      if (b.categoryId) { const cat = s.categories.find(c => c.id === b.categoryId); p.categoryId = cat?.id ?? p.categoryId; p.categoryName = cat?.name ?? p.categoryName; }
      return p;
    }
    if (method === 'DELETE') { p.active = false; return { ok: true }; }
  }
  // ---- Cocina ----
  if (root === 'kitchen') {
    if (id === 'orders' && method === 'GET') return s.orders.filter(kitchenVisible).map(o => ({
      id: o.id, orderNumber: o.orderNumber, tableLabel: o.tableLabel, channel: o.channel, openedAt: o.openedAt, customerPreferences: null,
      lines: o.lines.filter(l => !l.cancelledAt).map(l => ({ id: l.id, name: l.productName, quantity: l.quantity, kitchenStatus: l.kitchenStatus ?? 'received', station: stationOf(l.productId), modifications: l.modifications ?? [] })),
    })).filter(o => o.lines.some(l => l.kitchenStatus !== 'ready')).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
    if (id === 'lines' && parts[3] === 'status' && method === 'PATCH') {
      if (!['received', 'preparing', 'ready'].includes(b.status)) fail('Estado de cocina no válido');
      const line = s.orders.filter(kitchenVisible).flatMap(o => o.lines).find(l => l.id === action) ?? fail('Plato de cocina no encontrado');
      line.kitchenStatus = b.status; return { id: line.id, kitchen_status: line.kitchenStatus };
    }
    if (id === 'settings' && method === 'GET') return s.kitchenSettings ?? { printerName: '', printerMode: 'browser', printerHost: '', printerPort: 9100, ticketAutoprint: false, ticketWidth: 80 };
    if (id === 'settings' && method === 'PATCH') { s.kitchenSettings = { ...(s.kitchenSettings ?? {}), ...b }; return s.kitchenSettings; }
  }
  // ---- Salas ----
  if (root === 'rooms') {
    const rooms = demoRooms(s);
    const checkSize = (v: unknown) => v === undefined || (Number.isInteger(v) && Number(v) >= 100 && Number(v) <= 10000) || fail('Medidas de sala no válidas (100-10000 cm)');
    const checkName = (name: string, self?: string) => { if (rooms.some(r => r.active && r.id !== self && r.name.toLocaleLowerCase('es') === name.toLocaleLowerCase('es'))) fail('Ya existe una sala con ese nombre'); };
    if (!id && method === 'GET') return rooms.filter(r => r.active).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es')).map(r => {
      const ts = s.tables.filter(t => t.active !== false && t.zone === r.name);
      return { ...r, tableCount: ts.length, busyCount: ts.filter(t => activeFor(t.id)).length };
    });
    if (!id && method === 'POST') {
      const name = String(b.name || '').trim() || fail('El nombre de la sala es obligatorio'); checkName(name); checkSize(b.widthCm); checkSize(b.heightCm);
      const r: DemoRoom = { id: uid('room'), name, widthCm: b.widthCm ?? 800, heightCm: b.heightCm ?? 500, sortOrder: b.sortOrder ?? rooms.length, active: true };
      rooms.push(r); return r;
    }
    const r = rooms.find(x => x.id === id && x.active) ?? fail('Sala no encontrada');
    if (method === 'PATCH') {
      checkSize(b.widthCm); checkSize(b.heightCm);
      if (b.name !== undefined) { const name = String(b.name).trim() || fail('El nombre de la sala no puede estar vacío'); checkName(name, r.id); s.tables.filter(t => t.zone === r.name).forEach(t => { t.zone = name; }); r.name = name; }
      if (b.widthCm !== undefined) r.widthCm = b.widthCm;
      if (b.heightCm !== undefined) r.heightCm = b.heightCm;
      if (b.sortOrder !== undefined) r.sortOrder = b.sortOrder;
      return r;
    }
    if (method === 'DELETE') {
      const busy = s.tables.some(t => t.active !== false && t.zone === r.name && activeFor(t.id));
      if (busy && query.get('force') !== 'true') fail('La sala tiene comandas abiertas; confirma para archivarla');
      r.active = false; return { ok: true, archivedWithOpenOrders: busy };
    }
  }
  // ---- Mesas ----
  if (root === 'tables') {
    if (!id && method === 'GET') return s.tables.filter(t => t.active !== false).map(t => { const o = activeFor(t.id); return { ...tableView(t), seatsWarning: shapeWarning(t), activeOrder: o ? orderView(o) : null }; });
    const checkLabel = (label: string, self?: string) => { if (s.tables.some(t => t.id !== self && t.active !== false && t.label.toLocaleLowerCase('es') === label.toLocaleLowerCase('es'))) fail('Ya existe una mesa con ese nombre'); };
    if (!id && method === 'POST') {
      const label = String(b.label || '').trim() || fail('El nombre de la mesa es obligatorio');
      checkLabel(label);
      const shape = b.shape ?? 'square';
      const seats = b.seats ?? 4;
      if (!Number.isInteger(seats) || seats < 1 || seats > 20) fail('Número de comensales no válido (1-20)');
      const diameterCm = shape === 'round' ? roundDiameter(b.diameterCm ?? 90) : undefined;
      const widthCm = shape === 'square' ? squareSide(b.widthCm ?? 80) : undefined;
      const rect = shape === 'rect' ? rectMeasures(b) : undefined;
      const seatsRecommended = diameterCm ? roundRecommended(diameterCm) : (widthCm ? squareRecommended(widthCm) : (rect?.recommended ?? undefined));
      const t: DemoTable = { id: uid('table'), label, zone: b.zone?.trim() || 'Salón', seats, shape, diameterCm, widthCm, heightCm: rect ? rect.height : widthCm, sidesUsed: rect?.sides, seatsRecommended, seatsWarning: shapeWarning({ seats, shape, seatsRecommended } as DemoTable), posX: b.posX ?? 0, posY: b.posY ?? 0 };
      s.tables.push(t);
      return tableView(t);
    }
    if (id === 'qr-settings' && method === 'GET') return s.qrSettings ?? { approvalRequired: false, maxOrderLines: 20, cooldownSeconds: 120 };
    if (id === 'qr-settings' && method === 'PATCH') { s.qrSettings = { approvalRequired: !!b.approvalRequired, maxOrderLines: Number(b.maxOrderLines), cooldownSeconds: Number(b.cooldownSeconds) }; return s.qrSettings; }
    const t = s.tables.find(x => x.id === id && x.active !== false) ?? fail('Mesa no encontrada');
    if (action === 'join' && method === 'POST') {
      const o = s.tables.find(x => x.id === b.withId && x.id !== t.id && x.active !== false) ?? fail('Elige otra mesa para unir');
      const ot = activeFor(t.id), oo = activeFor(o.id);
      if (ot && oo) fail('Las dos mesas tienen comanda abierta; cobra una antes de unirlas');
      const [aw, ah] = [t.spanX ?? 1, t.spanY ?? 1];
      const others = s.tables.filter(x => x.active !== false && x.zone === t.zone && x.id !== t.id && x.id !== o.id).map(footprint);
      const grid = roomGrid(s, t.zone), fo = footprint(o);
      const u = joinedRect(footprint(t), o.zone === t.zone ? fo : { ...fo, x: -1000, y: -1000 }, others, grid.cols, grid.rows), ux = u.x, uy = u.y;
      growRoom(s, t.zone, u);
      const [first, second] = t.posX + t.posY <= o.posX + o.posY ? [t, o] : [o, t];
      const label = joinedLabel(first.label, second.label);
      checkLabel(label, t.id);
      t.mergedFrom = [...(t.mergedFrom ?? []), { joinedId: o.id, joinedZone: o.zone, widthCm: t.widthCm, heightCm: t.heightCm, diameterCm: t.diameterCm, label: t.label, seats: t.seats, shape: t.shape, spanX: aw, spanY: ah, offX: t.posX - ux, offY: t.posY - uy, joinedOffX: o.posX - ux, joinedOffY: o.posY - uy }];
      o.active = false;
      Object.assign(t, { label, seats: t.seats + o.seats, shape: 'rect', posX: ux, posY: uy, spanX: u.w, spanY: u.h, widthCm: u.w * 40, heightCm: u.h * 40, diameterCm: undefined, seatsRecommended: t.seats + o.seats });
      const order = ot ?? oo;
      if (order) { order.tableId = t.id; order.tableLabel = label; }
      return tableView(t);
    }
    if (action === 'split' && method === 'POST') {
      const last = t.mergedFrom?.[t.mergedFrom.length - 1] ?? fail('Esta mesa no está unida a otra');
      const o = s.tables.find(x => x.id === last.joinedId);
      if (o) checkLabel(o.label, o.id);
      const [px, py] = [t.posX, t.posY];
      const free = (zone: string, self: string) => s.tables.filter(x => x.active !== false && x.zone === zone && x.id !== self).map(footprint);
      const ft = footprint({ ...last, posX: 0, posY: 0, mergedFrom: t.mergedFrom!.slice(0, -1) });
      const tg = roomGrid(s, t.zone);
      const tp = freeSpot(free(t.zone, t.id), ft.w, ft.h, tg.cols, tg.rows, [{ x: px + last.offX, y: py + last.offY }, { x: px, y: py }]);
      growRoom(s, t.zone, { ...tp, w: ft.w, h: ft.h });
      Object.assign(t, { label: last.label, seats: last.seats, shape: last.shape, spanX: last.spanX, spanY: last.spanY, widthCm: last.widthCm, heightCm: last.heightCm, diameterCm: last.diameterCm, posX: tp.x, posY: tp.y, mergedFrom: t.mergedFrom!.slice(0, -1) });
      if (o) {
        const zone = last.joinedZone ?? t.zone, fo = footprint(o);
        const og = roomGrid(s, zone);
        const op = freeSpot(free(zone, o.id), fo.w, fo.h, og.cols, og.rows, [{ x: px + last.joinedOffX, y: py + last.joinedOffY }]);
        growRoom(s, zone, { ...op, w: fo.w, h: fo.h });
        Object.assign(o, { active: true, zone, posX: op.x, posY: op.y });
      }
      const order = activeFor(t.id);
      if (order) order.tableLabel = t.label;
      return tableView(t);
    }
    if (method === 'PATCH') {
      if (b.label !== undefined) { const label = String(b.label).trim() || fail('El nombre de la mesa no puede estar vacío'); checkLabel(label, t.id); t.label = label; const o = activeFor(t.id); if (o) o.tableLabel = label; }
      for (const k of ['zone', 'seats', 'shape', 'posX', 'posY'] as const) if (b[k] !== undefined) (t as any)[k] = b[k];
      const joined = (t.mergedFrom?.length ?? 0) > 0;
      if (!Number.isInteger(t.seats) || t.seats < 1 || t.seats > (joined ? 200 : 20)) fail('Número de comensales no válido (1-20)');
      if (joined) { t.shape = 'rect'; return tableView(t); } // la unión conserva su tamaño hasta separarla
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
        const existing = activeFor(t.id);
        if (existing) return { ...orderView(existing), reused: true };
        const o: DemoOrder = { id: uid('order'), orderNumber: s.nextOrder++, status: 'open', channel: 'table', tableId: t.id, tableLabel: t.label, openedAt: new Date().toISOString(), lines: [], payments: [] };
        s.orders.push(o);
        return { ...orderView(o), reused: false };
      }
      const o: DemoOrder = { id: uid('order'), orderNumber: s.nextOrder++, status: 'open', channel: b.channel || 'counter', tableId: null, tableLabel: b.tableLabel || null, openedAt: new Date().toISOString(), lines: [], payments: [] };
      s.orders.push(o);
      return { ...orderView(o), reused: false };
    }
    if (id === 'active' && method === 'GET') return s.orders.filter(o => o.status === 'open' || o.status === 'sent').map(orderView);
    const o = s.orders.find(x => x.id === id) ?? fail('Pedido no encontrado');
    if (!action && method === 'GET') return orderView(o);
    if (action === 'lines' && method === 'POST') {
      if (!['open', 'sent'].includes(o.status)) fail('Pedido inexistente, cerrado o no modificable');
      if (!b.productId || !(b.quantity > 0)) fail('Producto y cantidad positiva requeridos');
      addLine(o, b.productId, b.quantity, (b.addedIngredients || []).reduce((sum: number, i: any) => sum + Number(i.extraPriceNet || 0), 0), b.removeIngredientIds || [], (b.addedIngredients || []).map((i: any) => i.ingredientId));
      if (b.unitPriceGross !== undefined) {
        const price = Number(b.unitPriceGross);
        if (!Number.isFinite(price) || price < 0) fail('Precio ajustado no válido');
        if (!String(b.priceAdjustmentReason || '').trim()) fail('Indica el motivo del ajuste de precio');
        o.lines[o.lines.length - 1].lineGross = round(price * Number(b.quantity));
        s.activity.unshift({ id: uid('activity'), eventType: 'order.price_adjusted', targetId: o.id, details: { orderId: o.id, productId: b.productId, adjustedGross: price, reason: String(b.priceAdjustmentReason).trim() }, createdAt: new Date().toISOString(), actorName: 'Admin de demostración' });
      }
      return { ok: true };
    }
    if (action === 'lines' && method === 'DELETE') {
      const lineId = parts[3], reason = String(b.reason || '').trim();
      if (!reason) fail('Indica el motivo de anulación');
      if (paid(o) > 0) fail('No se puede anular una línea después de iniciar el cobro');
      const line = o.lines.find(x => x.id === lineId && !x.cancelledAt) || fail('La línea no existe o ya estaba anulada');
      line.cancelledAt = new Date().toISOString();
      line.cancellationReason = reason;
      return { ok: true };
    }
    if (action === 'send' && method === 'POST') { if (!['open', 'sent'].includes(o.status)) fail('El pedido no existe o ya fue enviado'); o.status = 'sent'; return { ok: true, orderId: o.id }; }
    if (action === 'payments' && method === 'POST') {
      if (!['cash', 'card'].includes(b.method)) fail('Forma de pago no válida: usa tarjeta (TPV) o efectivo');
      if (!['open', 'sent'].includes(o.status)) fail('Pedido no cobrable');
      const amount = round(Number(b.amount));
      if (!(amount > 0)) fail('Importe no válido');
      if (gross(o) <= 0) fail('La comanda no tiene importe que cobrar');
      if (paid(o) + amount > gross(o) + 0.001) fail('El pago supera el total pendiente');
      let cashTendered: number | null = null, changeGiven: number | null = null;
      if (b.method === 'cash') { cashTendered = b.cashTendered == null ? amount : round(Number(b.cashTendered)); if (cashTendered + 0.001 < amount) fail('El efectivo entregado no cubre el importe'); changeGiven = round(cashTendered - amount); }
      o.payments.push({ id: uid('pay'), method: b.method, amount, cashTendered, changeGiven, cardReference: b.method === 'card' ? (b.cardReference?.trim() || null) : null, paidAt: new Date().toISOString() });
      const accounting = s.accounting ||= { ledger: [] }; accounting.ledger ||= [];
      accounting.ledger.push({ id: uid('ledger'), date: new Date().toLocaleDateString('en-CA'), type: 'income', category: 'Ventas TPV', account: b.method === 'cash' ? 'cash' : 'bank', amountNet: amount, vat: 0, total: amount, sourceType: 'order_payment', notes: `Comanda ${o.orderNumber}` });
      const total = paid(o), closed = total + 0.001 >= gross(o);
      if (closed) o.status = 'paid';
      return { paid: total, remaining: Math.max(0, round(gross(o) - total)), closed, change: changeGiven };
    }
  }
  return fail(`Función no disponible en modo demo (${method} /${parts.join('/')})`);
}
