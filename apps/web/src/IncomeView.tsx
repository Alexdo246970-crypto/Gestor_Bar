import { useEffect, useState } from 'react';
import { DEMO, euro, request } from './lib';

type Line = { key: string; label: string; amount: number; formula: string; sources: string[]; weight: number | null; highlight?: boolean };
type Result = {
  from: string; to: string; lines: Line[];
  comparison: { previous: { from: string; to: string; net: number; grossMargin: number }; previousYear: { from: string; to: string; net: number; grossMargin: number } };
  ytd: { net: number; grossMargin: number };
  indicators: { grossMarginPct: number | null; personalPct: number | null; avgTicket: number; breakEvenSales: number | null };
  ledger: any[]; expenseBreakdown: any[];
};

export function IncomeView() {
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`), [to, setTo] = useState(new Date().toLocaleDateString('en-CA'));
  const [data, setData] = useState<Result | null>(null), [error, setError] = useState(''), [selected, setSelected] = useState<Line | null>(null);

  async function load() {
    if (DEMO) { setData(null); return; }
    try { setData(await request<Result>(`/reports/income-statement?from=${from}&to=${to}`)); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [from, to]);

  return <section className="finance-page">
    <div className="section-head"><div><h3>Estado de resultados</h3><p>Beneficio reproducible, con fórmula y detalle por línea</p></div>
      <a className="secondary button-link" href={`${DEMO ? '#' : `/api/reports/income-statement.csv?from=${from}&to=${to}`}`} download>↓ Exportar CSV</a></div>
    {error && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    <div className="finance-period"><label>Desde<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>Hasta<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
      <span>Máximo 2 años · las comparativas usan la misma duración</span></div>
    {data && <>
      <div className="kpi-grid">
        <article><span>Margen bruto</span><strong>{euro(data.lines.find(l => l.key === 'gross')?.amount ?? 0)}</strong><small>{data.indicators.grossMarginPct === null ? '—' : `${data.indicators.grossMarginPct} % de ventas`}</small></article>
        <article><span>EBITDA</span><strong>{euro(data.lines.find(l => l.key === 'ebitda')?.amount ?? 0)}</strong><small>Personal {data.indicators.personalPct === null ? '—' : `${data.indicators.personalPct} %`}</small></article>
        <article><span>Resultado neto</span><strong>{euro(data.lines.find(l => l.key === 'net')?.amount ?? 0)}</strong><small>YTD {euro(data.ytd.net)}</small></article>
      </div>
      <div className="ledger-lines income-lines">{data.lines.map(l => <button key={l.key} className={`ledger-line income-line ${l.highlight ? 'highlight' : ''}`} onClick={() => setSelected(l)}>
        <strong>{l.label}</strong><small>{l.formula}</small><small>{l.weight === null ? '—' : `${l.weight} %`}</small><b className={l.amount < 0 ? 'negative' : ''}>{euro(l.amount)}</b>
      </button>)}</div>
      <div className="content-grid"><section><div className="section-head"><div><h3>Comparativa</h3><p>Mismo rango en el año anterior y periodo previo</p></div></div>
        <div className="ledger-lines"><div className="ledger-line"><span>Año anterior</span><small>{data.comparison.previousYear.from} … {data.comparison.previousYear.to}</small><b>{euro(data.comparison.previousYear.net)}</b></div>
          <div className="ledger-line"><span>Periodo previo</span><small>{data.comparison.previous.from} … {data.comparison.previous.to}</small><b>{euro(data.comparison.previous.net)}</b></div>
          <div className="ledger-line"><span>Ticket medio</span><small>Ventas brutas / pedidos</small><b>{euro(data.indicators.avgTicket)}</b></div>
          <div className="ledger-line"><span>Punto de equilibrio</span><small>Costes fijos / margen bruto %</small><b>{data.indicators.breakEvenSales === null ? '—' : euro(data.indicators.breakEvenSales)}</b></div>
        </div>
      </section><section><div className="section-head"><div><h3>Detalle de movimientos</h3><p>{data.ledger.length} apuntes del libro en el rango</p></div></div>
        <div className="ledger-lines">{selected ? data.ledger.filter(l => !selected.sources.length || selected.sources.includes(l.sourceType) || selected.sources.includes(l.category)).slice(0, 30).map((l, i) => <div key={i} className="ledger-line"><span>{l.date}</span><small>{l.category} · {l.sourceType || 'manual'} · {l.reference || ''}</small><b>{euro(l.total)}</b></div>) : <p className="finance-note">Pulsa una línea del estado para ver sus movimientos.</p>}</div>
      </section></div>
    </>}
    {selected && <div className="order-notice" onClick={() => setSelected(null)}>{selected.label}: {selected.formula} → {euro(selected.amount)}</div>}
  </section>;
}
