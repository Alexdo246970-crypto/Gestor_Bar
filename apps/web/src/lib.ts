import type { Product } from '@bar/contracts';
import { demoRequest } from './demoApi';

export const API = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
export const DEMO = import.meta.env.VITE_DEMO_MODE === 'true';

export type DiningTable = {
  id: string; label: string; zone: string; seats: number; shape: 'square' | 'round' | 'bar'; posX: number; posY: number;
  activeOrder: null | { id: string; orderNumber: number; status: 'open' | 'sent'; openedAt: string; grossTotal: number; paidTotal: number; lineCount: number };
};
export type OrderDetail = {
  id: string; orderNumber: number; status: string; channel: string; tableId: string | null; tableLabel: string | null; openedAt: string;
  grossTotal: number; paidTotal: number;
  lines: { id: string; productId: string; productName: string; quantity: number; lineGross: number }[];
  payments?: { id: string; method: 'cash' | 'card'; amount: number; cashTendered?: number | null; changeGiven?: number | null; cardReference?: string | null; paidAt: string }[];
};
export type Category = { id: string; name: string; sortOrder?: number };
export type AdminProduct = Product & { description?: string | null; categoryName?: string | null };

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (DEMO) return demoRequest<T>(path, init);
  const response = await fetch(`${API}${path}`, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json', ...init.headers } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message || `Error ${response.status}`); }
  return response.json();
}

export const euro = (value: number | string) => `${Number(value || 0).toFixed(2)} €`;
export const grossPrice = (p: { priceNet: number | string; vatRate: number | string }) => Number(p.priceNet) * (1 + Number(p.vatRate) / 100);

export function menuSection(product: Product) {
  const raw = String((product as any).categoryName || product.categoryId || 'Otros'), key = raw.toLocaleLowerCase('es');
  if (key.includes('café') || key.includes('bebida')) return 'Bebidas';
  if (key.includes('desayuno')) return 'Desayunos';
  if (key.includes('racion')) return product.id === 'demo-14' ? 'Primeros platos' : 'Entrantes';
  if (key.includes('principal')) return product.id === 'demo-21' ? 'Primeros platos' : 'Segundos platos';
  if (key.includes('postre')) return 'Postres';
  return raw;
}
