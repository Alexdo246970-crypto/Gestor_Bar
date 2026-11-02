export type Role = 'admin' | 'manager' | 'waiter' | 'cashier';
export type OrderStatus = 'open' | 'sent' | 'paid' | 'cancelled';
export interface Product { id: string; name: string; categoryId: string | null; priceNet: number; vatRate: number; active: boolean }
export interface OrderLineInput { productId: string; quantity: number }
export interface SessionUser { id: string; email: string; fullName: string; tenantId: string; tenantName: string; role: Role }
