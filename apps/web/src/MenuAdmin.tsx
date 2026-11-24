import { FormEvent, useEffect, useState } from 'react';
import { AdminProduct, Category, euro, grossPrice, request } from './lib';

const VAT_OPTIONS = [10, 21, 4, 0];
type Editing = { mode: 'new' } | { mode: 'edit'; product: AdminProduct };

/** Gestión de la carta: añadir, editar, retirar y recuperar productos. */
export function MenuAdmin({ onChanged }: { onChanged: () => void }) {
  const [products, setProducts] = useState<AdminProduct[]>([]), [categories, setCategories] = useState<Category[]>([]), [search, setSearch] = useState(''), [category, setCategory] = useState('Todas'), [showRemoved, setShowRemoved] = useState(false), [editing, setEditing] = useState<Editing | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false), [newCategory, setNewCategory] = useState(false), [pvp, setPvp] = useState(''), [vat, setVat] = useState(10);
  const [menuView,setMenuView]=useState<'products'|'menus'>('products');

  async function load() {
    try { const [p, c] = await Promise.all([request<AdminProduct[]>('/products/admin'), request<Category[]>('/categories')]); setProducts(p); setCategories(c); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  const categoryOf = (p: AdminProduct) => p.categoryName || categories.find(c => c.id === p.categoryId)?.name || 'Sin categoría';
  const visible = products.filter(p => (showRemoved || p.active !== false) && (category === 'Todas' || categoryOf(p) === category) && `${p.name} ${p.description || ''}`.toLocaleLowerCase('es').includes(search.toLocaleLowerCase('es')));
  const groups = [...new Set(visible.map(categoryOf))];
  const activeCount = products.filter(p => p.active !== false).length, removedCount = products.length - activeCount;

  function open(target: Editing) {
    setEditing(target); setNewCategory(false); setError('');
    if (target.mode === 'edit') { setPvp(grossPrice(target.product).toFixed(2)); setVat(Number(target.product.vatRate)); } else { setPvp(''); setVat(10); }
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!editing || saving) return;
    const f = new FormData(e.currentTarget), price = Number(pvp);
    if (!(price >= 0) || pvp === '') { setError('Indica un precio válido'); return; }
    setSaving(true); setError('');
    try {
      let categoryId = String(f.get('categoryId') || '') || null;
      if (newCategory) { const name = String(f.get('newCategory') || '').trim(); if (!name) throw new Error('Escribe el nombre de la nueva categoría'); categoryId = (await request<Category>('/categories', { method: 'POST', body: JSON.stringify({ name, sortOrder: categories.length }) })).id; }
      const payload = { name: String(f.get('name')).trim(), description: String(f.get('description') || '').trim() || null, categoryId, vatRate: vat, priceNet: Math.round(price / (1 + vat / 100) * 10000) / 10000 };
      if (editing.mode === 'new') await request('/products', { method: 'POST', body: JSON.stringify(payload) });
      else await request(`/products/${editing.product.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      setNotice(editing.mode === 'new' ? `«${payload.name}» añadido a la carta.` : `«${payload.name}» actualizado.`);
      setEditing(null); await load(); onChanged();
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  }

  async function setActive(p: AdminProduct, active: boolean) {
    if (!active && !confirm(`¿Quitar «${p.name}» de la carta? Podrás recuperarlo después.`)) return;
    try {
      if (active) await request(`/products/${p.id}`, { method: 'PATCH', body: JSON.stringify({ active: true }) });
      else await request(`/products/${p.id}`, { method: 'DELETE' });
      setNotice(active ? `«${p.name}» vuelve a estar en la carta.` : `«${p.name}» retirado de la carta.`); await load(); onChanged();
    } catch (e) { setError((e as Error).message); }
  }

  const netPreview = Number(pvp) / (1 + vat / 100);
  if(menuView==='menus') return <section className="menu-admin"><div className="section-head"><div><h3>Gestión de menús</h3><p>Configura varios menús con precio y fecha de servicio</p></div><button className="secondary" onClick={()=>setMenuView('products')}>Volver a productos</button></div><DailyMenusAdmin/></section>;
  return <section className="menu-admin">
    <div className="section-head"><div><h3>Gestión de la carta</h3><p>Añade platos y bebidas, cambia precios o quítalos de la venta</p><button className="text-button" onClick={()=>setMenuView('menus')}>Gestionar menús del día →</button></div><button className="primary" onClick={() => open({ mode: 'new' })}>＋ Nuevo producto</button></div>
    {error && !editing && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    {notice && <div className="order-notice" onClick={() => setNotice('')}>✓ {notice}</div>}
    <div className="stock-toolbar"><label className="stock-search"><span>⌕</span><input aria-label="Buscar producto" placeholder="Buscar en la carta…" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="stock-filters">{['Todas', ...new Set(products.map(categoryOf))].map(c => <button key={c} className={category === c ? 'selected' : ''} onClick={() => setCategory(c)}>{c}</button>)}
        <button className={showRemoved ? 'selected' : ''} onClick={() => setShowRemoved(!showRemoved)}>Ver retirados <span>{removedCount}</span></button></div></div>
    <p className="finance-note">{activeCount} productos en venta{removedCount ? ` · ${removedCount} retirados` : ''}</p>
    {groups.map(g => <div className="menu-admin-group" key={g}><div className="menu-section-title"><h3>{g}</h3><span>{visible.filter(p => categoryOf(p) === g).length}</span></div>
      <div className="table">{visible.filter(p => categoryOf(p) === g).map(p => <div className={`table-row menu-admin-row ${p.active === false ? 'removed' : ''}`} key={p.id}>
        <span><strong>{p.name}</strong>{p.description && <small className="inventory-sub">{p.description}</small>}</span>
        <span className="menu-price"><strong>{euro(grossPrice(p))}</strong><small className="inventory-sub">IVA {Number(p.vatRate)}% incl.</small></span>
        <span>{p.active === false ? <span className="state-pill free">Retirado</span> : <span className="state-pill sent">En carta</span>}</span>
        <span className="menu-admin-actions"><button className="text-button" onClick={() => open({ mode: 'edit', product: p })}>Editar</button>
          {p.active === false ? <button className="text-button" onClick={() => void setActive(p, true)}>Recuperar</button> : <button className="remove-button" onClick={() => void setActive(p, false)}>Quitar</button>}</span>
      </div>)}</div></div>)}
    {!visible.length && <div className="empty">No hay productos que coincidan.</div>}

    {editing && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setEditing(null); }}>
      <form className="package-modal" onSubmit={save}>
        <button type="button" className="modal-close" onClick={() => setEditing(null)} aria-label="Cerrar">×</button>
        <p className="eyebrow">{editing.mode === 'new' ? 'NUEVO PRODUCTO' : 'EDITAR PRODUCTO'}</p>
        <h3>{editing.mode === 'new' ? 'Añadir a la carta' : editing.product.name}</h3>
        <label>Nombre<input name="name" required autoFocus defaultValue={editing.mode === 'edit' ? editing.product.name : ''} placeholder="Ej. Calamares a la romana" /></label>
        <label>Descripción (opcional)<input name="description" defaultValue={editing.mode === 'edit' ? editing.product.description || '' : ''} /></label>
        <label>Categoría{!newCategory
          ? <select name="categoryId" defaultValue={editing.mode === 'edit' ? editing.product.categoryId || '' : categories[0]?.id || ''}><option value="">Sin categoría</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          : <input name="newCategory" placeholder="Nombre de la nueva categoría" autoFocus />}</label>
        <button type="button" className="text-button" onClick={() => setNewCategory(!newCategory)}>{newCategory ? '← Elegir una categoría existente' : '＋ Crear categoría nueva'}</button>
        <div className="form-pair">
          <label>Precio de venta (€, IVA incl.)<input type="number" min="0" step="0.01" required value={pvp} onChange={e => setPvp(e.target.value)} /></label>
          <label>IVA<select value={vat} onChange={e => setVat(Number(e.target.value))}>{VAT_OPTIONS.map(v => <option key={v} value={v}>{v}%</option>)}</select></label>
        </div>
        {pvp !== '' && Number.isFinite(netPreview) && <p className="modal-description">Base imponible {euro(netPreview)} + IVA {euro(Number(pvp) - netPreview)}</p>}
        {editing.mode === 'edit' && <p className="modal-description">El nuevo precio se aplica a las comandas nuevas; las ya enviadas conservan su precio.</p>}
        {error && <p className="error">{error}</p>}
        <div className="modal-actions"><button type="button" className="secondary" onClick={() => setEditing(null)}>Cancelar</button><button className="primary" disabled={saving}>{saving ? 'Guardando…' : editing.mode === 'new' ? 'Añadir a la carta' : 'Guardar cambios'}</button></div>
      </form>
    </div>}
  </section>;
}

type DailyMenu = { id:string; date:string; name:string; priceNet:number; vatRate:number; products:{id:string;name:string}[] };
function DailyMenusAdmin(){
  const [date,setDate]=useState(new Date().toLocaleDateString('en-CA')),[menus,setMenus]=useState<DailyMenu[]>([]),[products,setProducts]=useState<AdminProduct[]>([]),[selected,setSelected]=useState<string[]>([]),[error,setError]=useState(''),[notice,setNotice]=useState(''),[saving,setSaving]=useState(false);
  async function load(){try{const [m,p]=await Promise.all([request<DailyMenu[]>(`/daily-menus?date=${date}`),request<AdminProduct[]>('/products/admin')]);setMenus(m);setProducts(p.filter(x=>x.active!==false))}catch(e){setError((e as Error).message)}}
  useEffect(()=>{void load()},[date]);
  async function create(e:FormEvent<HTMLFormElement>){e.preventDefault();if(saving)return;setSaving(true);setError('');const form=e.currentTarget;const f=new FormData(form);const gross=Number(f.get('price')),vatRate=Number(f.get('vatRate'));if(!(gross>=0)){setError('Indica un precio válido');setSaving(false);return}try{await request('/daily-menus',{method:'POST',body:JSON.stringify({date,name:String(f.get('name')).trim(),priceNet:Math.round(gross/(1+vatRate/100)*100)/100,vatRate,productIds:selected})});setNotice('Menú añadido para la fecha seleccionada.');setSelected([]);form.reset();await load()}catch(err){setError((err as Error).message)}finally{setSaving(false)}}
  return <><div className="finance-period"><label>Fecha de servicio<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><span>Menús activos para el día seleccionado</span></div>{error&&<p className="error">{error}</p>}{notice&&<div className="order-notice">✓ {notice}</div>}<div className="finance-card">{menus.map(m=><div className="finance-row" key={m.id}><span><strong>{m.name}</strong><small>{m.products.map(p=>p.name).join(' · ')||'Sin productos'}</small></span><strong>{euro(Number(m.priceNet)*(1+Number(m.vatRate)/100))}</strong></div>)}{!menus.length&&<p className="finance-note">No hay menús para esta fecha.</p>}</div><form className="package-modal menu-daily-form" onSubmit={create}><p className="eyebrow">NUEVO MENÚ</p><div className="form-pair"><label>Nombre<input name="name" required placeholder="Menú de temporada"/></label><label>Precio final (€)<input name="price" type="number" min="0" step="0.01" required/></label></div><label>IVA<select name="vatRate" defaultValue="10"><option value="10">10%</option><option value="21">21%</option><option value="4">4%</option><option value="0">0%</option></select></label><p className="modal-description">Productos incluidos</p><div className="modifier-list">{products.map(p=><label className="ingredient-check" key={p.id}><input type="checkbox" checked={selected.includes(p.id)} onChange={e=>setSelected(current=>e.target.checked?[...current,p.id]:current.filter(id=>id!==p.id))}/><span>{p.name}</span><small>{euro(grossPrice(p))}</small></label>)}</div><button className="primary" disabled={saving}>{saving?'Guardando…':'Crear menú'}</button></form></>;
}
