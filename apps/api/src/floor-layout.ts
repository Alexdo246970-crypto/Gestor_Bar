// Reglas de colocación en el plano de sala (mismas que apps/web/src/floorLayout.ts).
/** Plano sin sala creada (modo antiguo): 8 × 5 casillas de 40 cm, igual que el cliente. */
export const DEFAULT_COLS = 8, DEFAULT_ROWS = 5;
export type Rect = { x: number; y: number; w: number; h: number };

export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Columnas/filas mínimas para que quepan todas las mesas. */
export const extent = (rects: Rect[]) => ({ cols: Math.max(0, ...rects.map(r => r.x + r.w)), rows: Math.max(0, ...rects.map(r => r.y + r.h)) });

/** Primer hueco libre de w×h: prueba las posiciones preferidas y luego recorre el plano; si no cabe, lo pone debajo (la sala crece). */
export function freeSpot(others: Rect[], w: number, h: number, cols: number, rows: number, prefer: { x: number; y: number }[] = []) {
  const fits = (x: number, y: number, maxRows: number) => x >= 0 && y >= 0 && x + w <= Math.max(cols, w) && y + h <= maxRows && !others.some(o => overlaps(o, { x, y, w, h }));
  for (const p of prefer) if (fits(p.x, p.y, rows)) return p;
  for (let y = 0; y + h <= rows; y++) for (let x = 0; x + w <= Math.max(cols, w); x++) if (fits(x, y, rows)) return { x, y };
  return { x: 0, y: Math.max(rows, extent(others).rows) };
}

/**
 * Rectángulo de la mesa unida. Si las dos mesas ya forman un rectángulo se queda así; si no, la mesa resultante
 * mide la suma de ambas (en horizontal o en vertical) y se coloca donde estaba la mesa destino o en el primer hueco libre.
 */
export function joinedRect(a: Rect, o: Rect, others: Rect[], cols: number, rows: number): Rect {
  const horizontal = a.y === o.y && a.h === o.h && (a.x + a.w === o.x || o.x + o.w === a.x);
  const vertical = a.x === o.x && a.w === o.w && (a.y + a.h === o.y || o.y + o.h === a.y);
  if (horizontal || vertical) return { x: Math.min(a.x, o.x), y: Math.min(a.y, o.y), w: horizontal ? a.w + o.w : a.w, h: vertical ? a.h + o.h : a.h };
  const sizes = [{ w: a.w + o.w, h: Math.max(a.h, o.h) }, { w: Math.max(a.w, o.w), h: a.h + o.h }];
  for (const s of sizes) {
    const prefer = [{ x: a.x, y: a.y }, { x: a.x + a.w - s.w, y: a.y }, { x: a.x, y: a.y + a.h - s.h }, { x: o.x, y: o.y }, { x: o.x + o.w - s.w, y: o.y }];
    const p = freeSpot(others, s.w, s.h, cols, rows, prefer);
    if (p.y + s.h <= rows) return { ...p, ...s };
  }
  return { ...freeSpot(others, sizes[0].w, sizes[0].h, cols, rows), ...sizes[0] };
}
