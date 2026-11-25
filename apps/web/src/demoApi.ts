// Backend simulado en memoria para VITE_DEMO_MODE=true. Replica las reglas principales de la API real
// (una comanda activa por mesa, pagos por tarjeta TPV o efectivo, cierre al completar el total).
import type { Product } from '@bar/contracts';

type DemoProduct = Product & { description?: string | null; categoryName?: string | null; [extra: string]: unknown };
type DemoLine = { id: string; productId: string; productName: string; quantity: number; lineGross: number; cancelledAt?:string; cancellationReason?:string; addedBy?:string };
type DemoPayment = { id: string; method: 'cash' | 'card'; amount: number; cashTendered: number | null; changeGiven: number | null; cardReference: string | null; paidAt: string };
type DemoOrder = { id: string; orderNumber: number; status: 'open' | 'sent' | 'paid'; channel: string; tableId: string | null; tableLabel: string | null; openedAt: string; lines: DemoLine[]; payments: DemoPayment[] };
type DemoTable = { id: string; label: string; zone: string; seats: number; shape: 'square' | 'round' | 'bar'; posX: number; posY: number };
type DemoDailyMenu = {id:string;date:string;name:string;priceNet:number;vatRate:number;products:{id:string;name:string}[]};
type DemoIngredient={id:string;name:string;unit:string;quantityPerUnit?:number};
type Store = { products: DemoProduct[]; categories: { id: string; name: string; sortOrder: number }[]; tables: DemoTable[]; orders: DemoOrder[]; dailyMenus:DemoDailyMenu[]; staff:{id:string;email:string;fullName:string;role:string;active:boolean}[]; activity:{id:string;eventType:string;targetId:string|null;details:Record<string,unknown>;createdAt:string;actorName:string|null}[]; tenant:{name:string;slug:string;timezone:string;currency:string}; nextOrder: number };

const STORAGE_KEY = 'barraos-demo-v2';
let seedProducts: DemoProduct[] = [];
let seedIngredients: DemoIngredient[] = [];
let demoExtraPrices: Record<string,Record<string,number>> = {};
let store: Store | null = null;

export function seedDemoProducts(products: Product[], ingredients: DemoIngredient[] = [], extraPrices: Record<string,Record<string,number>> = {}) { seedProducts = products as DemoProduct[]; seedIngredients=ingredients; demoExtraPrices=extraPrices; }

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const round = (n: number) => Math.round(n * 100) / 100;
const gross = (o: DemoOrder) => round(o.lines.filter(l=>!l.cancelledAt).reduce((s, l) => s + l.lineGross, 0));
const paid = (o: DemoOrder) => round(o.payments.reduce((s, p) => s + p.amount, 0));
const fail = (message: string): never => { throw new Error(message); };

function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* almacenamiento no disponible */ } }

function load(): Store {
  if (store) return store;
  try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) { store = JSON.parse(raw); store!.dailyMenus ||= []; store!.staff ||= []; store!.staff.forEach(x=>x.active??=true); store!.activity ||= []; store!.tenant ||= {name:'La Esquina',slug:'la-esquina',timezone:'Europe/Madrid',currency:'EUR'}; return store!; } } catch { /* ignorar */ }
  const categoryNames = [...new Set(seedProducts.map(p => String(p.categoryId)))];
  const tables: DemoTable[] = [
    ...[1, 2, 3, 4, 5, 6].map((n, i) => ({ id: `t-salon-${n}`, label: `Mesa ${n}`, zone: 'Salón', seats: n === 5 || n === 6 ? 6 : 4, shape: (n % 3 === 0 ? 'round' : 'square') as DemoTable['shape'], posX: 1 + (i % 3) * 2, posY: 1 + Math.floor(i / 3) * 2 })),
    ...[1, 2, 3, 4].map((n, i) => ({ id: `t-terraza-${n}`, label: `Terraza ${n}`, zone: 'Terraza', seats: 2, shape: 'round' as const, posX: 1 + i * 2, posY: 1 })),
    ...[1, 2, 3].map((n, i) => ({ id: `t-barra-${n}`, label: `Barra ${n}`, zone: 'Barra', seats: 1, shape: 'bar' as const, posX: 1 + i, posY: 1 })),
  ];
  store = { products: seedProducts.map(p => ({ ...p, categoryName: String(p.categoryId) })), categories: categoryNames.map((name, i) => ({ id: name, name, sortOrder: i })), tables, orders: [], dailyMenus:[],staff:[],activity:[],tenant:{name:'La Esquina',slug:'la-esquina',timezone:'Europe/Madrid',currency:'EUR'}, nextOrder: 104 };
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

function orderView(o: DemoOrder) { return { ...o, grossTotal: gross(o), paidTotal: paid(o), lineCount: o.lines.filter(l=>!l.cancelledAt).length }; }
function activeFor(tableId: string) { return load().orders.find(o => o.tableId === tableId && (o.status === 'open' || o.status === 'sent')); }

export async function demoRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  await new Promise(r => setTimeout(r, 60));
  const s = load(), method = (init.method || 'GET').toUpperCase(), body = init.body ? JSON.parse(String(init.body)) : {};
  const [route,queryString=''] = path.split('?'), parts = route.split('/').filter(Boolean);
  const result = handle(s, method, parts, body, new URLSearchParams(queryString));
  save();
  return JSON.parse(JSON.stringify(result)) as T;
}

function handle(s: Store, method: string, parts: string[], b: any, query:URLSearchParams): unknown {
  const [root, id, action] = parts;
  if(root==='activity'&&method==='GET')return s.activity;
  if(root==='tenant'&&method==='GET')return s.tenant;
  if(root==='tenant'&&method==='PATCH'){if(b.name!==undefined)s.tenant.name=String(b.name).trim();if(b.timezone!==undefined)s.tenant.timezone=String(b.timezone).trim();return s.tenant;}
  if(root==='staff'&&method==='GET')return s.staff;
  if(root==='staff'&&method==='POST'){
    if(!b.email||!b.fullName||String(b.password||'').length<12||!['admin','owner','manager','waiter','temporary_waiter','cashier'].includes(b.role))fail('Datos de perfil no válidos');
    const member={id:uid('staff'),email:String(b.email).toLowerCase(),fullName:String(b.fullName).trim(),role:b.role,active:true};s.staff.push(member);
    s.activity.unshift({id:uid('activity'),eventType:'staff.created',targetId:member.id,details:{email:member.email,role:member.role},createdAt:new Date().toISOString(),actorName:'Admin de demostración'});return member;
  }
  if(root==='staff'&&id&&method==='PATCH'){
    const member=s.staff.find(x=>x.id===id)||fail('Usuario no encontrado');if(b.role)member.role=b.role;if(b.active!==undefined)member.active=Boolean(b.active);
    s.activity.unshift({id:uid('activity'),eventType:'staff.updated',targetId:id,details:{role:member.role,active:member.active},createdAt:new Date().toISOString(),actorName:'Admin de demostración'});return member;
  }
  if(root==='staff'&&id&&method==='DELETE'){
    const member=s.staff.find(x=>x.id===id)||fail('Usuario no encontrado');member.active=false;
    s.activity.unshift({id:uid('activity'),eventType:'staff.deactivated',targetId:id,details:{role:member.role},createdAt:new Date().toISOString(),actorName:'Admin de demostración'});return {ok:true};
  }
  if(root==='inventory'&&id==='ingredients'&&method==='GET')return seedIngredients.map((i,index)=>({ ...i,currentStock:18+index,minStock:5,unitCost:0.01,stockValue:(18+index)*0.01,packageLabel:'Paquete',packageSize:1000,packagePriceNet:10,defaultVatRate:10 }));
  if(root==='products'&&action==='modifiers'&&method==='GET'){
    const product=s.products.find(x=>x.id===id)||fail('Producto inexistente'),base=(((product as any).ingredients||[]) as DemoIngredient[]).map(x=>({...x,quantityPerUnit:Number(x.quantityPerUnit||1)})),allowed=((product as any).allowedExtraIds||[]) as string[],prices=(product as any).allowedExtraPrices||demoExtraPrices[id]||{};
    return {base,available:allowed.map(ingredientId=>({...seedIngredients.find(x=>x.id===ingredientId),extraPriceNet:Number(prices[ingredientId]||0)})).filter((x:any)=>x.id)};
  }
  if(root==='recipes'&&id&&method==='POST'){
    const product=s.products.find(x=>x.id===id)||fail('Producto inexistente'),base=Array.isArray(b.ingredients)?b.ingredients:[],allowed=Array.isArray(b.allowedIngredients)?b.allowedIngredients:[];
    (product as any).ingredients=base.map((x:any)=>{const ingredient=seedIngredients.find(i=>i.id===x.ingredientId)||fail('Ingrediente no disponible');return{...ingredient,quantityPerUnit:Number(x.quantity)}});
    (product as any).allowedExtraIds=allowed.map((x:any)=>x.ingredientId);(product as any).allowedExtraPrices=Object.fromEntries(allowed.map((x:any)=>[x.ingredientId,Number(x.extraPriceNet)]));return{ok:true};
  }
  // ---- Carta ----
  if (root === 'menu' && method === 'GET') { const today=new Date().toLocaleDateString('en-CA'); return s.products.filter(p => p.active !== false && (!p.availableFrom||String(p.availableFrom).slice(0,10)<=today) && (!p.availableTo||String(p.availableTo).slice(0,10)>=today)); }
  if (root === 'daily-menus') {
    if(method==='GET'){const date=query.get('date')||new Date().toLocaleDateString('en-CA');return s.dailyMenus.filter(m=>m.date===date)}
    if(method==='POST'){if(!b.name||!b.date||!Number.isFinite(b.priceNet)||!Number.isFinite(b.vatRate))fail('Nombre, fecha y precio válidos requeridos');const items=(b.productIds||[]).map((id:string)=>{const p=s.products.find(x=>x.id===id);if(!p)return fail('Producto de menú no disponible');return{id:p.id,name:p.name}});const menu={id:uid('daily-menu'),date:b.date,name:String(b.name).trim(),priceNet:b.priceNet,vatRate:b.vatRate,products:items};s.dailyMenus.push(menu);return{id:menu.id}}
  }
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
      const p: DemoProduct = { id: uid('prod'), name: b.name.trim(), description: b.description || null, categoryId: cat?.id ?? null, categoryName: cat?.name ?? null, priceNet: b.priceNet, vatRate: b.vatRate, active: true, availableFrom:b.availableFrom||null, availableTo:b.availableTo||null };
      s.products.push(p); return p;
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
      if (b.unitPriceGross !== undefined) {
        const price = Number(b.unitPriceGross);
        if (!Number.isFinite(price) || price < 0) fail('Precio ajustado no válido');
        if (!String(b.priceAdjustmentReason||'').trim()) fail('Indica el motivo del ajuste de precio');
        o.lines[o.lines.length - 1].lineGross = round(price * Number(b.quantity));
        s.activity.unshift({id:uid('activity'),eventType:'order.price_adjusted',targetId:o.id,details:{orderId:o.id,productId:b.productId,adjustedGross:price,reason:String(b.priceAdjustmentReason).trim()},createdAt:new Date().toISOString(),actorName:'Admin de demostración'});
      }
      return { ok: true };
    }
    if (action === 'lines' && method === 'DELETE') {
      const lineId=parts[3],reason=String(b.reason||'').trim();if(!reason)fail('Indica el motivo de anulación');if(paid(o)>0)fail('No se puede anular una línea después de iniciar el cobro');const line=o.lines.find(x=>x.id===lineId&&!x.cancelledAt)||fail('La línea no existe o ya estaba anulada');line.cancelledAt=new Date().toISOString();line.cancellationReason=reason;return{ok:true};
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
