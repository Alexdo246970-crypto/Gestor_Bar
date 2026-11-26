import { FormEvent, useEffect, useState } from 'react';
import { DEMO, euro, request } from './lib';

type Period = { id: string; periodKey: string; startDate: string; endDate: string; dueDate: string; outputVat: number; inputVat: number; roundingAdjustment: number; result: number; status: string; notes: string | null };
type Alert = { periodKey?: string; dueDate: string; result?: number; name?: string; amount?: number };
type OtherTax = { id: string; name: string; amount: number; period: string | null; dueDate: string | null; reference: string | null; paid: boolean };
type Settings = { frequency: 'monthly' | 'quarterly'; vatRegime: string; dueDay: number; thresholdPct: number };

export function TaxesView({ canEdit }: { canEdit: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null), [periods, setPeriods] = useState<Period[]>([]), [others, setOthers] = useState<OtherTax[]>([]);
  const [alerts, setAlerts] = useState<{ periods: Alert[]; otherTaxes: Alert[] }>({ periods: [], otherTaxes: [] });
  const [year, setYear] = useState(new Date().getFullYear()), [detail, setDetail] = useState<(Period & { entries: any[]; currentResult: number | null; difference: number | null }) | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [showOther, setShowOther] = useState(false);

  async function load() {
    try {
      const [s, p, o, a] = await Promise.all([
        request<Settings>('/tax/settings'), request<Period[]>(`/tax/periods?year=${year}`),
        request<OtherTax[]>('/tax/other'), request<{ periods: Alert[]; otherTaxes: Alert[] }>('/tax/alerts')
      ]);
      setSettings(s); setPeriods(p); setOthers(o); setAlerts(a);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [year]);

  async function act(url: string, body: object = {}, message = 'Operación registrada.') {
    try { await request(url, { method: 'POST', body: JSON.stringify(body) }); setNotice(message); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function saveSettings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await act('/tax/settings', { frequency: String(f.get('frequency')), vatRegime: String(f.get('vatRegime')), dueDay: Number(f.get('dueDay')), thresholdPct: Number(f.get('thresholdPct')) }, 'Configuración fiscal guardada.');
  }
  async function addOther(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await act('/tax/other', { name: String(f.get('name')), amount: Number(f.get('amount')), period: String(f.get('period') || ''), dueDate: String(f.get('dueDate') || ''), reference: String(f.get('reference') || '') }, 'Impuesto registrado.');
    setShowOther(false);
  }
  async function open(id: string) {
    try { setDetail(await request<Period & { entries: any[]; currentResult: number | null; difference: number | null }>(`/tax/periods/${id}`)); } catch (e) { setError((e as Error).message); }
  }

  const hasAlerts = alerts.periods.length + alerts.otherTaxes.length > 0;
  return <section className="finance-page">
    <div className="section-head"><div><h3>Impuestos y liquidaciones</h3><p>IVA devengado por fecha de operación, con facturas auditables</p></div></div>
    {error && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    {notice && <div className="order-notice" onClick={() => setNotice('')}>✓ {notice}</div>}
    {hasAlerts && <div className="tax-alerts"><strong>Próximos vencimientos</strong>
      {alerts.periods.map((a, i) => <span key={`p${i}`}>{a.periodKey}: {euro(a.result ?? 0)} el {a.dueDate}</span>)}
      {alerts.otherTaxes.map((a, i) => <span key={`o${i}`}>{a.name}: {euro(a.amount ?? 0)} el {a.dueDate}</span>)}
    </div>}
    <p className="finance-note">Cálculo orientativo: la asesoría fiscal debe validar régimen, deducciones y redondeos antes de presentar.</p>
    <div className="content-grid"><section><div className="section-head"><div><h3>Configuración</h3><p>Frecuencia y vencimiento del local</p></div></div>
      {settings && <form onSubmit={saveSettings} className="table-form">
        <label>Frecuencia<select name="frequency" defaultValue={settings.frequency} disabled={!canEdit}><option value="monthly">Mensual</option><option value="quarterly">Trimestral</option></select></label>
        <label>Régimen<select name="vatRegime" defaultValue={settings.vatRegime} disabled={!canEdit}><option value="general">General</option><option value="simplified">Simplificado</option><option value="exempt">Exento</option></select></label>
        <div className="form-pair"><label>Día de vencimiento<input name="dueDay" type="number" min="1" max="28" defaultValue={settings.dueDay} disabled={!canEdit} /></label>
          <label>Umbral de aviso (%)<input name="thresholdPct" type="number" min="0" step="0.1" defaultValue={settings.thresholdPct} disabled={!canEdit} /></label></div>
        {canEdit && <button className="primary wide">Guardar configuración</button>}
      </form>}
    </section><section><div className="section-head"><div><h3>Otros impuestos</h3><p>IBI, tasas y impuestos propios</p></div>
      {canEdit && <button className="secondary" onClick={() => setShowOther(true)}>＋ Añadir</button>}</div>
      <div className="ledger-lines">{others.map(t => <div key={t.id} className="ledger-line"><span>{t.name}</span><small>{t.period || 'Sin periodo'} · {t.dueDate || 'sin vencimiento'}</small><b>{euro(t.amount)}</b>
        {canEdit && !t.paid && <button className="secondary" onClick={() => void act(`/tax/other/${t.id}/pay`, {}, 'Pago contabilizado.')}>Pagar</button>}
        {t.paid && <small>pagado</small>}</div>)}{!others.length && <p className="finance-note">Sin otros impuestos registrados.</p>}</div>
    </section></div>

    <div className="section-head"><div><h3>Periodos de liquidación</h3><p>{periods.length} periodos para {year}</p></div>
      <div><input type="number" value={year} onChange={e => setYear(Number(e.target.value))} aria-label="Año" />
        {canEdit && <button className="secondary" onClick={() => void act('/tax/periods/generate', { year }, 'Periodos generados y calculados.')}>Generar {year}</button>}</div></div>
    <div className="ledger-lines">{periods.map(p => <div key={p.id} className="salary-line">
      <strong>{p.periodKey}</strong><span>{p.status === 'open' ? 'Abierto' : p.status === 'filed' ? 'Presentado' : 'Pagado'}</span>
      <small>Repercutido {euro(p.outputVat)}</small><small>Soportado {euro(p.inputVat)}</small><b>{euro(p.result)}</b>
      <button className="text-button" onClick={() => void open(p.id)}>Ver facturas</button>
      {canEdit && p.status === 'open' && <button className="secondary" onClick={() => void act(`/tax/periods/${p.id}/close`, {}, 'Periodo presentado; gasto registrado si hay saldo.')}>Cerrar</button>}
      {canEdit && p.status === 'filed' && <button className="secondary" onClick={() => void act(`/tax/periods/${p.id}/pay`, {}, 'Pago registrado.')}>Marcar pagado</button>}
    </div>)}{!periods.length && <p className="finance-note">Genera los periodos del año para ver el cálculo.</p>}</div>

    {detail && <div className="modal-backdrop"><div className="modal-card"><div className="section-head"><div><h3>{detail.periodKey}</h3><p>{detail.startDate} – {detail.endDate} · vencimiento {detail.dueDate}</p></div><button className="secondary" onClick={() => setDetail(null)}>×</button></div>
      <p className="finance-note">Repercutido {euro(detail.outputVat)} − soportado {euro(detail.inputVat)} = {euro(detail.result)} · ajuste de redondeo {euro(detail.roundingAdjustment)}</p>
      {detail.difference !== null && <p className="finance-note">Periodo cerrado: cálculo actual {euro(detail.currentResult ?? 0)} · diferencia {euro(detail.difference)} (el importe presentado no se modifica).</p>}
      <div className="ledger-lines">{detail.entries.map((entry, i) => <div key={i} className="ledger-line"><span>{entry.sourceType}</span><small>{entry.operationDate}</small><b>{euro(entry.vat)}</b></div>)}{!detail.entries.length && <p className="finance-note">Sin facturas incluidas.</p>}</div>
    </div></div>}
    {showOther && <div className="modal-backdrop"><form className="modal-card" onSubmit={addOther}>
      <div className="section-head"><div><h3>Nuevo impuesto</h3><p>Se contabilizará al registrar el pago</p></div></div>
      <label>Nombre<input name="name" required placeholder="IBI, tasa de basura…" /></label>
      <div className="form-pair"><label>Importe<input name="amount" type="number" min="0.01" step="0.01" required /></label><label>Periodo<input name="period" placeholder="2026-01" /></label></div>
      <div className="form-pair"><label>Vencimiento<input name="dueDate" type="date" /></label><label>Justificante<input name="reference" /></label></div>
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setShowOther(false)}>Cancelar</button><button className="primary">Guardar</button></div>
    </form></div>}
  </section>;
}
