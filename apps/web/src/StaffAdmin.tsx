import { FormEvent, useEffect, useState } from 'react';
import { request } from './lib';

type StaffMember = { id: string; email: string; fullName: string; role: string; active: boolean };
type Activity = { id: string; eventType: string; targetId: string | null; details: Record<string, unknown>; createdAt: string; actorName: string | null };
const roles = ['admin','owner','manager','waiter','temporary_waiter','cashier'];
const roleLabels: Record<string,string> = { admin:'Administrador', owner:'Propietario', manager:'Encargado', waiter:'Camarero', temporary_waiter:'Camarero temporal', cashier:'Caja' };
const roleHelp: Record<string,string> = {
  admin:'Administra usuarios, permisos y la configuración del local.', owner:'Consulta resultados e información del negocio; no puede alterar la operación.',
  manager:'Gestiona carta, mesas, inventario y finanzas.', waiter:'Consulta mesas y crea o amplía comandas; no accede a finanzas ni configuración.',
  temporary_waiter:'Atiende comandas durante el servicio; no gestiona carta, inventario ni cobros.', cashier:'Consulta pedidos y registra cobros.'
};
const activityLabel: Record<string,string> = { 'staff.created':'Creó un perfil', 'staff.updated':'Actualizó un perfil', 'staff.deactivated':'Desactivó un perfil', 'order.line_added':'Añadió una línea a una comanda', 'order.line_cancelled':'Anuló una línea de comanda', 'order.price_adjusted':'Ajustó el precio de una línea', 'order.sent':'Envió una comanda a cocina', 'payment.recorded':'Registró un pago', 'tenant.updated':'Actualizó los datos del negocio' };

export function StaffAdmin() {
  const [staff,setStaff] = useState<StaffMember[]>([]), [activity,setActivity] = useState<Activity[]>([]);
  const [error,setError] = useState(''), [notice,setNotice] = useState(''), [role,setRole] = useState('waiter'), [saving,setSaving] = useState(false);
  async function load() {
    try { const [members,events] = await Promise.all([request<StaffMember[]>('/staff'),request<Activity[]>('/activity')]); setStaff(members); setActivity(events); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (saving) return; setSaving(true); setError('');
    const form=e.currentTarget, data=new FormData(form);
    try {
      await request('/staff',{method:'POST',body:JSON.stringify({email:String(data.get('email')),fullName:String(data.get('fullName')),password:String(data.get('password')),role})});
      form.reset(); setNotice('Perfil creado. Comparte las credenciales por un canal seguro.'); await load();
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  }
  async function changeRole(member: StaffMember, nextRole: string) {
    if (nextRole===member.role) return;
    try { await request(`/staff/${member.id}`,{method:'PATCH',body:JSON.stringify({role:nextRole})}); setNotice(`Perfil actualizado: ${roleLabels[nextRole]}.`); await load(); }
    catch (e) { setError((e as Error).message); await load(); }
  }
  async function deactivate(member: StaffMember) {
    if (!window.confirm(`¿Desactivar el acceso de ${member.fullName}?`)) return;
    try { await request(`/staff/${member.id}`,{method:'DELETE'}); setNotice('Acceso desactivado y sesiones cerradas.'); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function activate(member: StaffMember) {
    try { await request(`/staff/${member.id}`,{method:'PATCH',body:JSON.stringify({active:true})}); setNotice('Acceso activado.'); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  return <section className="menu-admin staff-admin">
    <div className="section-head"><div><h3>Equipo y permisos</h3><p>Gestiona los perfiles del local. Cada acción queda registrada.</p></div></div>
    {error&&<div className="toast" role="alert" onClick={()=>setError('')}>{error} ×</div>}
    {notice&&<div className="order-notice" role="status" onClick={()=>setNotice('')}>✓ {notice}</div>}
    <div className="table staff-list"><div className="table-row table-head staff-row"><span>Persona</span><span>Perfil</span><span>Estado</span><span>Acciones</span></div>
      {staff.map(member=><div className={`table-row staff-row ${member.active?'':'staff-inactive'}`} key={member.id}>
        <span><strong>{member.fullName}</strong><small className="inventory-sub">{member.email}</small></span>
        <select aria-label={`Perfil de ${member.fullName}`} value={member.role} onChange={e=>void changeRole(member,e.target.value)} disabled={!member.active}>
          {roles.map(key=><option key={key} value={key}>{roleLabels[key]}</option>)}
        </select>
        <span className={`state-pill ${member.active?'sent':'inactive-pill'}`}>{member.active?'Activo':'Desactivado'}</span>
        {member.active?<button className="remove-button" onClick={()=>void deactivate(member)}>Desactivar</button>:<button className="text-button" onClick={()=>void activate(member)}>Activar</button>}
      </div>)}
      {!staff.length&&<p className="finance-note">No hay personal registrado.</p>}
    </div>
    <form className="package-modal staff-form" onSubmit={add}>
      <p className="eyebrow">AÑADIR AL EQUIPO</p>
      <label>Nombre<input name="fullName" autoComplete="name" required/></label>
      <label>Email<input name="email" type="email" autoComplete="email" required/></label>
      <label>Contraseña inicial<input name="password" type="password" autoComplete="new-password" minLength={12} required/><small className="inventory-sub">Mínimo 12 caracteres.</small></label>
      <label>Perfil<select value={role} onChange={e=>setRole(e.target.value)}>{roles.map(key=><option key={key} value={key}>{roleLabels[key]}</option>)}</select></label>
      <p className="modal-description">{roleHelp[role]}</p>
      <button className="primary" disabled={saving}>{saving?'Creando…':'Crear perfil'}</button>
    </form>
    <section className="activity-log"><div className="section-head"><div><h3>Actividad reciente</h3><p>Últimas acciones de gestión de usuarios</p></div></div>
      {activity.map(event=><div className="activity-row" key={event.id}><span><strong>{activityLabel[event.eventType]||event.eventType}</strong><small>{event.actorName||'Usuario'} · {String(event.details?.reason||event.details?.productName||event.details?.email||event.details?.role||'')}</small></span><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString('es-ES')}</time></div>)}
      {!activity.length&&<p className="finance-note">Todavía no hay acciones registradas.</p>}
    </section>
  </section>;
}
