import { FormEvent, useCallback, useEffect, useState } from 'react';
import type { Role } from '@bar/contracts';
import { DEMO, request } from './lib';

type Member = {
  id: string; email: string; fullName: string; role: Role; active: boolean;
  expiresAt: string | null; createdAt?: string; hasSession: boolean;
};

const demoMembers: Member[] = [
  { id: 'demo-admin', email: 'admin@barraos.local', fullName: 'Admin de demostración', role: 'admin', active: true, expiresAt: null, hasSession: true },
  { id: 'demo-kitchen', email: 'cocina@barraos.local', fullName: 'Equipo de cocina', role: 'kitchen', active: true, expiresAt: null, hasSession: false },
];

const roleLabel: Record<string, string> = { admin: 'Administración', manager: 'Gerencia', waiter: 'Camarero', cashier: 'Caja', kitchen: 'Cocina' };

export function Team() {
  const [members, setMembers] = useState<Member[]>([]);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [saving, setSaving] = useState(false), [loading, setLoading] = useState(true);
  const [selectedRole, setSelectedRole] = useState<Role>('kitchen');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (DEMO) setMembers(current => current.length ? current : demoMembers);
      else setMembers(await request<Member[]>('/staff'));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(''); setNotice(''); setSaving(true);
    const form = e.currentTarget;
    const f = new FormData(form);
    const payload = {
      fullName: String(f.get('fullName') || '').trim(),
      email: String(f.get('email') || '').trim(),
      password: String(f.get('password') || ''),
      role: String(f.get('role') || 'kitchen') as Role,
      expiresAt: String(f.get('expiresAt') || '') || null,
    };
    try {
      if (DEMO) {
        setMembers(current => [...current, { id: `demo-${Date.now()}`, fullName: payload.fullName, email: payload.email, role: payload.role, active: true, hasSession: false, expiresAt: payload.expiresAt ? new Date(payload.expiresAt).toISOString() : null }]);
      } else {
        const created = await request<Member>('/staff', { method: 'POST', body: JSON.stringify(payload) });
        setMembers(current => [...current, created]);
      }
      setNotice(payload.role === 'kitchen'
        ? 'Perfil de cocina creado. Ya puede entrar con la contraseña temporal.'
        : 'Perfil de camarero creado. Ya puede entrar con la contraseña temporal.');
      form.reset();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  async function toggle(member: Member) {
    setError(''); setNotice('');
    try {
      if (!DEMO) await request(`/staff/${member.id}`, { method: 'PATCH', body: JSON.stringify({ active: !member.active }) });
      setMembers(current => current.map(m => m.id === member.id ? { ...m, active: !m.active, hasSession: false } : m));
      setNotice(member.active ? `Acceso de ${member.fullName} desactivado y sesiones cerradas.` : `Acceso de ${member.fullName} reactivado.`);
    } catch (e) { setError((e as Error).message); }
  }

  async function revoke(member: Member) {
    setError(''); setNotice('');
    try {
      if (!DEMO) await request(`/staff/${member.id}/revoke-sessions`, { method: 'POST' });
      setMembers(current => current.map(m => m.id === member.id ? { ...m, hasSession: false } : m));
      setNotice(`Sesiones de ${member.fullName} revocadas.`);
    } catch (e) { setError((e as Error).message); }
  }

  return <section className="temporary-staff">
    <div className="section-head"><div><h3>Equipo</h3><p>Altas de cocina y perfiles temporales de sala o caja; desactivación y revocación de sesiones.</p></div><button className="secondary" onClick={() => void load()}>Actualizar ↻</button></div>
    {notice && <div className="order-notice">✓ {notice}</div>}
    {error && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    <div className="team-layout">
      <form className="package-modal staff-form" onSubmit={create}>
        <p className="eyebrow">NUEVO ACCESO</p>
        <h3>Crear usuario interno</h3>
        <label>Rol<select name="role" value={selectedRole} onChange={e => setSelectedRole(e.target.value as Role)}><option value="kitchen">Cocina</option><option value="waiter">Camarero temporal</option><option value="cashier">Caja temporal</option></select></label>
        <label>Nombre completo<input name="fullName" required autoFocus /></label>
        <label>Email de acceso<input name="email" type="email" required /></label>
        <label>Contraseña temporal<input name="password" type="password" minLength={12} required /><small>Mínimo 12 caracteres</small></label>
        <label>Caduca el<input name="expiresAt" type="datetime-local" min={new Date(Date.now() + 60000).toISOString().slice(0, 16)} max={new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16)} required={selectedRole !== 'kitchen'} /><small>Obligatorio para perfiles temporales; máximo 30 días.</small></label>
        <button className="primary" disabled={saving}>{saving ? 'Creando perfil…' : 'Crear perfil →'}</button>
        <p className="finance-note">Cocina solo verá comandas y los ajustes de su impresora. No puede acceder a mesas, cobros, carta, inventario ni finanzas.</p>
      </form>
      <div className="team-list">
        <div className="section-head"><div><h3>Miembros del local</h3><p>{members.length} perfiles</p></div></div>
        {loading ? <div className="empty">Cargando equipo…</div> : <div className="table">
          <div className="table-row table-head team-row"><span>Perfil</span><span>Rol</span><span>Estado</span><span>Caduca</span><span></span></div>
          {members.map(member => <div className="table-row team-row" key={member.id}>
            <span><strong>{member.fullName}</strong><small>{member.email}</small></span>
            <span>{roleLabel[member.role] || member.role}</span>
            <span>{member.active ? 'Activo' : 'Inactivo'}{member.hasSession ? ' · sesión abierta' : ''}</span>
            <span>{member.expiresAt ? new Date(member.expiresAt).toLocaleDateString('es-ES') : 'Sin caducidad'}</span>
            <span className="team-actions">
              {member.hasSession && <button className="text-button" onClick={() => void revoke(member)}>Revocar sesión</button>}
              <button className={member.active ? 'remove-button' : 'text-button'} onClick={() => void toggle(member)}>{member.active ? 'Desactivar' : 'Reactivar'}</button>
            </span>
          </div>)}
        </div>}
      </div>
    </div>
  </section>;
}
