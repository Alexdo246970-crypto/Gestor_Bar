import { useEffect, useState } from 'react';
import { API, DEMO, request } from './lib';

type Period = 'day' | 'week' | 'month' | 'year' | 'range';
type Row = Record<string, any>;
type Variation = { current: number; previous: number; absolute: number; percent: number | null };
type Report = {
  date: string; period: Period; startDate: string; endDate: string; comparisonPeriod: { from: string; to: string };
  sales: Row; payments: Row[]; purchases: Row; supplierBreakdown: Row[]; expenses: Row; expenseBreakdown: Row[]; budgetPerformance: Row[];
  kpis: Record<string, number>;
  comparison: { from: string; to: string; previous: Record<string, number>; kpis: Record<string, Variation> };
  coherence: {
    supplierBreakdown: { expected: number; actual: number; difference: number; ok: boolean };
    payments: { expected: number; actual: number; difference: number; ok: boolean };
    ledger: { incomeTotal: number; expenseTotal: number; balance: number };
    cashClosure: Row | null;
  };
  estimatedIngredientCost: number; estimatedGrossMargin: number; estimatedOperatingResult: number;
  payroll: number; taxes: number; operatingResult: number; netResult: number;
  deductibleInputVat: number; estimatedVatBalance: number;
};

const KPI_LABELS: Record<string, string> = {
  salesNet: 'Ventas netas', collected: 'Cobros recibidos', billedGross: 'Ventas con IVA',
  purchases: 'Compras a proveedores', ingredientCost: 'Coste de ingredientes', grossMargin: 'Margen bruto',
  operatingExpenses: 'Gastos operativos', payroll: 'Sueldos y Seguridad Social', taxes: 'Impuestos liquidados',
  operatingResult: 'Resultado operativo', netResult: 'Resultado neto',
  vatOutput: 'IVA repercutido', vatInput: 'IVA soportado deducible', vatBalance: 'IVA estimado a liquidar'
};
const KPI_KEYS = Object.keys(KPI_LABELS);
const num = (v: unknown) => Number(v || 0);
const round = (n: number) => Math.round(n * 100) / 100;
const money = (v: unknown) => num(v).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const percent = (v: number | null) => v === null ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`;

function demoReport(from: string, to: string, period: Period): Report {
  const sales = { net: 1248.4, vat: 124.84, gross: 1373.24, orders: 42 };
  const purchases = { net: 520, vat: 52, gross: 572, deductible_vat: 52 };
  const expenses = { net: 205, vat: 12.3, gross: 217.3, deductible_vat: 12.3 };
  const supplierBreakdown = [
    { supplier: 'Distribuciones Norte', net: 320, vat: 32, gross: 352, deductible_vat: 32 },
    { supplier: 'Mercado Central', net: 200, vat: 20, gross: 220, deductible_vat: 20 }
  ];
  const payments = [{ method: 'cash', amount: 480 }, { method: 'card', amount: 893.24 }];
  const expenseBreakdown = [{ category: 'Suministros', net: 120, vat: 7.2, gross: 127.2 }, { category: 'Personal', net: 85, vat: 0, gross: 85 }];
  const ingredientCost = 385.2, grossMargin = round(sales.net - ingredientCost), payroll = 0, taxes = 0;
  const operatingResult = round(grossMargin - expenses.net - payroll), netResult = round(operatingResult - taxes);
  const kpis: Record<string, number> = {
    salesNet: sales.net, collected: sales.gross, billedGross: sales.gross, purchases: purchases.gross,
    ingredientCost, grossMargin, operatingExpenses: expenses.net, payroll, taxes, operatingResult, netResult,
    vatOutput: sales.vat, vatInput: 64.3, vatBalance: 60.54
  };
  const previous: Record<string, number> = {}, kpiVariation: Record<string, Variation> = {};
  for (const [key, value] of Object.entries(kpis)) {
    previous[key] = round(value * 0.9);
    kpiVariation[key] = { current: value, previous: previous[key], absolute: round(value - previous[key]), percent: 11.11 };
  }
  return {
    date: to, period, startDate: from, endDate: to, comparisonPeriod: { from, to },
    sales, payments, purchases, supplierBreakdown, expenses, expenseBreakdown, budgetPerformance: [],
    kpis, comparison: { from, to, previous, kpis: kpiVariation },
    coherence: {
      supplierBreakdown: { expected: 572, actual: 572, difference: 0, ok: true },
      payments: { expected: sales.gross, actual: sales.gross, difference: 0, ok: true },
      ledger: { incomeTotal: sales.gross, expenseTotal: 777, balance: round(sales.gross - 777) }, cashClosure: null
    },
    estimatedIngredientCost: ingredientCost, estimatedGrossMargin: grossMargin, estimatedOperatingResult: round(grossMargin - expenses.net),
    payroll, taxes, operatingResult, netResult, deductibleInputVat: 64.3, estimatedVatBalance: 60.54
  };
}

function Stat({ title, value, note, delta }: { title: string; value: string; note: string; delta?: Variation }) {
  return <article className="stat"><span>{title}</span><strong>{value}</strong><small>{note}</small>
    {delta && <small className={`variation ${delta.absolute > 0 ? 'positive' : delta.absolute < 0 ? 'negative' : ''}`}>
      {delta.absolute > 0 ? '▲' : delta.absolute < 0 ? '▼' : '='} {money(Math.abs(delta.absolute))} · {percent(delta.percent)}
    </small>}
  </article>;
}

export function FinanceView() {
  const today = new Date().toLocaleDateString('en-CA');
  const [period, setPeriod] = useState<Period>('month');
  const [date, setDate] = useState(today);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');

  const query = () => period === 'range'
    ? new URLSearchParams({ from, to }).toString()
    : new URLSearchParams({ date, period }).toString();

  async function load() {
    setError('');
    try {
      if (DEMO) { setReport(demoReport(from, to, period)); return; }
      setReport(await request<Report>(`/reports/daily?${query()}`));
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [period, date, from, to]);

  const empty = !!report && !num(report.sales.orders) && !report.payments.length && !report.supplierBreakdown.length && !report.expenseBreakdown.length;
  const variation = (key: string) => report?.comparison.kpis[key];

  return <section className="finance">
    <div className="section-head"><div><h3>Resumen financiero</h3><p>Ventas, costes, sueldos, impuestos y resultado neto del periodo</p></div>
      <div className="finance-actions">
        <a className={`secondary button-link ${DEMO ? 'disabled' : ''}`} href={DEMO ? '#' : `${API}/reports/daily.csv?${query()}`} download>↓ CSV</a>
        <button className="secondary" onClick={() => window.print()}>🖨 PDF</button>
        <button className="secondary" onClick={() => void load()}>Actualizar ↻</button>
      </div></div>
    {error && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    <div className="finance-period">
      <label>Periodo<select value={period} onChange={e => setPeriod(e.target.value as Period)}>
        <option value="day">Día</option><option value="week">Semana</option><option value="month">Mes</option><option value="year">Año</option><option value="range">Rango libre</option>
      </select></label>
      {period === 'range'
        ? <><label>Desde<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
          <label>Hasta<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label></>
        : <label>Fecha de referencia<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>}
      <span>Máximo 2 años · variación frente al periodo anterior de igual duración</span>
    </div>
    {report && <>
      {empty && <p className="finance-note">Sin operaciones en el periodo: todos los importes son 0,00 €.</p>}
      <div className="stats">
        <Stat title="Ventas netas" value={money(report.sales.net)} note={`${num(report.sales.orders)} pedidos cerrados`} delta={variation('salesNet')} />
        <Stat title="Cobros recibidos" value={money(report.payments.reduce((sum, p) => sum + num(p.amount), 0))} note="Pagos del periodo" delta={variation('collected')} />
        <Stat title="Compras a proveedores" value={money(report.purchases.gross)} note={`${money(report.purchases.net)} base + IVA`} delta={variation('purchases')} />
        <Stat title="Coste de ingredientes" value={money(report.estimatedIngredientCost)} note="Consumo real en ventas" delta={variation('ingredientCost')} />
        <Stat title="Margen bruto" value={money(report.estimatedGrossMargin)} note="Ventas netas − ingredientes" delta={variation('grossMargin')} />
        <Stat title="Gastos operativos" value={money(report.expenses.net)} note="Base neta del periodo" delta={variation('operatingExpenses')} />
        <Stat title="Sueldos y SS empresa" value={money(report.payroll)} note="Nóminas confirmadas y pagadas" delta={variation('payroll')} />
        <Stat title="Impuestos liquidados" value={money(report.taxes)} note="IVA e impuestos presentados" delta={variation('taxes')} />
        <Stat title="Resultado operativo" value={money(report.operatingResult)} note="Margen − gastos − sueldos" delta={variation('operatingResult')} />
        <Stat title="Resultado neto" value={money(report.netResult)} note="Operativo − impuestos" delta={variation('netResult')} />
        <Stat title="IVA repercutido" value={money(report.sales.vat)} note="Cobrado en ventas" delta={variation('vatOutput')} />
        <Stat title="IVA soportado deducible" value={money(report.deductibleInputVat)} note="Compras y gastos deducibles" delta={variation('vatInput')} />
        <Stat title="IVA estimado a liquidar" value={money(report.estimatedVatBalance)} note="Informativo, no es un gasto" delta={variation('vatBalance')} />
      </div>
      <div className="finance-details">
        <article className="finance-card">
          <h3>Comparativa con el periodo anterior</h3>
          <p className="finance-note">{report.comparisonPeriod.from} … {report.comparisonPeriod.to} · misma duración</p>
          <div className="compare-grid"><span>Concepto</span><span>Anterior</span><span>Actual</span><span>Δ €</span><span>Δ %</span>
            {KPI_KEYS.map(key => {
              const v = report.comparison.kpis[key];
              if (!v) return null;
              return <div className="compare-row" key={key}><span>{KPI_LABELS[key]}</span><span>{money(v.previous)}</span><strong>{money(v.current)}</strong>
                <span className={v.absolute > 0 ? 'positive' : v.absolute < 0 ? 'negative' : ''}>{v.absolute > 0 ? '+' : ''}{money(v.absolute)}</span>
                <span className={v.percent !== null && v.percent > 0 ? 'positive' : v.percent !== null && v.percent < 0 ? 'negative' : ''}>{percent(v.percent)}</span></div>;
            })}
          </div>
        </article>
        <article className="finance-card">
          <h3>Cuadre y cierre de caja</h3>
          <div className="finance-row"><span>Proveedores vs. total compras
            <small>{money(report.coherence.supplierBreakdown.actual)} / {money(report.coherence.supplierBreakdown.expected)}</small></span>
            <strong className={report.coherence.supplierBreakdown.ok ? 'ok' : 'low'}>{report.coherence.supplierBreakdown.ok ? 'Cuadra' : `Dif. ${money(report.coherence.supplierBreakdown.difference)}`}</strong></div>
          <div className="finance-row"><span>Pagos vs. ventas cobradas
            <small>{money(report.coherence.payments.actual)} / {money(report.coherence.payments.expected)}</small></span>
            <strong className={report.coherence.payments.ok ? 'ok' : 'low'}>{report.coherence.payments.ok ? 'Cuadra' : `Dif. ${money(report.coherence.payments.difference)}`}</strong></div>
          <div className="finance-row"><span>Libro de cuentas<small>Ingresos {money(report.coherence.ledger.incomeTotal)} · gastos {money(report.coherence.ledger.expenseTotal)}</small></span>
            <strong>{money(report.coherence.ledger.balance)}</strong></div>
          {report.coherence.cashClosure && <div className="finance-row"><span>Último arqueo<small>{report.coherence.cashClosure.businessDate} · esperado {money(report.coherence.cashClosure.expectedCash)}</small></span>
            <strong className={num(report.coherence.cashClosure.cashDifference) === 0 ? 'ok' : 'low'}>{money(report.coherence.cashClosure.cashDifference)}</strong></div>}
          <p className="finance-note">Las cifras del libro se filtran por la misma fecha de operación que el resumen.</p>
        </article>
        <article className="finance-card"><h3>Pagos recibidos</h3>
          {report.payments.map((p, i) => <div className="finance-row" key={`${p.method}-${i}`}><span>{p.method === 'cash' ? 'Efectivo' : p.method === 'card' ? 'Tarjeta' : 'Otros'}</span><strong>{money(p.amount)}</strong></div>)}
          {!report.payments.length && <p className="finance-note">Sin cobros en el periodo.</p>}
          <div className="finance-row muted-row"><span>Total cobrado</span><strong>{money(report.payments.reduce((sum, p) => sum + num(p.amount), 0))}</strong></div></article>
        <article className="finance-card"><h3>Costes por proveedor</h3>
          {report.supplierBreakdown.map((p: Row) => <div className="finance-row" key={p.supplier}><span>{p.supplier}<small>Base {money(p.net)} · IVA {money(p.vat)} ({money(p.deductible_vat)} deducible)</small></span><strong>{money(p.gross)}</strong></div>)}
          {!report.supplierBreakdown.length && <p className="finance-note">Sin facturas recibidas.</p>}
          <div className="finance-row muted-row"><span>Total compras</span><strong>{money(report.purchases.gross)}</strong></div></article>
        <article className="finance-card"><h3>Liquidación estimada de IVA</h3>
          <div className="finance-row"><span>IVA repercutido en ventas</span><strong>{money(report.sales.vat)}</strong></div>
          <div className="finance-row"><span>IVA deducible de proveedores</span><strong>− {money(report.purchases.deductible_vat)}</strong></div>
          <div className="finance-row"><span>IVA deducible de gastos</span><strong>− {money(report.expenses.deductible_vat)}</strong></div>
          <div className="finance-row muted-row"><span>Estimación a liquidar</span><strong>{money(report.estimatedVatBalance)}</strong></div>
          <p className="finance-note">Estimación informativa; la deducibilidad final depende de la factura y la normativa aplicable.</p></article>
        <article className="finance-card"><h3>Gastos y presupuesto mensual</h3>
          {report.budgetPerformance.map((b: Row) => <div className="finance-row" key={b.category}><span>{b.category}<small>Presupuesto {money(b.planned)}</small></span>
            <strong className={num(b.actual) > num(b.planned) ? 'low' : ''}>{money(b.actual)}</strong></div>)}
          {!report.budgetPerformance.length && report.expenseBreakdown.map((e: Row) => <div className="finance-row" key={e.category}><span>{e.category}</span><strong>{money(e.net)}</strong></div>)}
          {!report.budgetPerformance.length && !report.expenseBreakdown.length && <p className="finance-note">Aún no hay gastos o presupuestos registrados.</p>}</article>
      </div>
      <p className="finance-note">Margen bruto = ventas netas − coste de ingredientes. Resultado operativo = margen bruto − gastos operativos − sueldos. Resultado neto = resultado operativo − impuestos liquidados. El saldo de IVA estimado es una obligación pendiente, no un gasto.</p>
    </>}
  </section>;
}
