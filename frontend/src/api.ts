export interface Product {
  id: number;
  name: string;
  pricePaise: number;
  stock: number;
  availableUnits: number;
}

export type OrderStatus = 'pending' | 'paid' | 'expired' | 'needs_review' | 'picked_up';

export interface Order {
  id: string;
  status: OrderStatus;
  totalPaise: number;
  items: Array<{ productId: number; name: string; quantity: number; unitPricePaise: number }>;
  expiresInSeconds: number;
  reviewReason: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// Returns the parsed body plus the local monotonic time at the midpoint of the
// request, which is our best guess for when the server measured anything time-based.
async function call<T>(path: string, init?: RequestInit): Promise<{ data: T; measuredAt: number }> {
  const started = performance.now();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const measuredAt = (started + performance.now()) / 2;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? `HTTP ${res.status}`);
  }
  return { data: body as T, measuredAt };
}

export const api = {
  products: () => call<Product[]>('/products').then((r) => r.data),
  placeOrder: (items: Array<{ productId: number; quantity: number }>) =>
    call<Order>('/orders', { method: 'POST', body: JSON.stringify({ items }) }),
  order: (id: string) => call<Order>(`/orders/${id}`),
};
