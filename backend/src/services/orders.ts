import { pool, withTransaction } from '../db';
import { config } from '../config';
import { AppError } from '../errors';
import { heldUnits, lockProducts } from './stock';

export type OrderStatus = 'pending' | 'paid' | 'expired' | 'needs_review' | 'picked_up';

export interface OrderItemInput {
  productId: number;
  quantity: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

const MAX_QTY_PER_LINE = 20;

export function parseOrderItems(body: unknown): OrderItemInput[] {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError(400, 'INVALID_ORDER', 'items must be a non-empty array of {productId, quantity}');
  }

  const merged = new Map<number, number>();
  for (const item of items) {
    const { productId, quantity } = (item ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(productId) || !Number.isInteger(quantity) || (quantity as number) < 1) {
      throw new AppError(400, 'INVALID_ORDER', 'each item needs an integer productId and a quantity of at least 1');
    }
    merged.set(productId as number, (merged.get(productId as number) ?? 0) + (quantity as number));
  }

  for (const [productId, quantity] of merged) {
    if (quantity > MAX_QTY_PER_LINE) {
      throw new AppError(400, 'INVALID_ORDER', `quantity for product ${productId} is above the limit of ${MAX_QTY_PER_LINE}`);
    }
  }

  return [...merged.entries()]
    .sort(([a], [b]) => a - b)
    .map(([productId, quantity]) => ({ productId, quantity }));
}

export async function createOrder(items: OrderItemInput[]) {
  const ids = items.map((i) => i.productId);

  const orderId = await withTransaction(async (client) => {
    const products = await lockProducts(client, ids);
    const byId = new Map(products.map((p) => [p.id, p]));

    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length) {
      throw new AppError(400, 'UNKNOWN_PRODUCT', `unknown product id(s): ${unknown.join(', ')}`);
    }

    const held = await heldUnits(client, ids);
    const shortages = items
      .map((i) => {
        const available = byId.get(i.productId)!.stock - (held.get(i.productId) ?? 0);
        return { productId: i.productId, requested: i.quantity, available };
      })
      .filter((s) => s.available < s.requested);

    if (shortages.length) {
      throw new AppError(409, 'INSUFFICIENT_STOCK', 'not enough stock for one or more items', shortages);
    }

    const total = items.reduce((sum, i) => sum + byId.get(i.productId)!.price_paise * i.quantity, 0);

    const { rows } = await client.query(
      `INSERT INTO orders (status, total_paise, expires_at)
       VALUES ('pending', $1, now() + make_interval(secs => $2))
       RETURNING id`,
      [total, config.holdSeconds],
    );
    const id = rows[0].id as string;

    for (const i of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price_paise) VALUES ($1, $2, $3, $4)`,
        [id, i.productId, i.quantity, byId.get(i.productId)!.price_paise],
      );
    }
    return id;
  });

  return (await getOrder(orderId))!;
}

export async function getOrder(id: string) {
  if (!isUuid(id)) return null;

  // Flip an expired hold to 'expired' as soon as anyone looks at it,
  // instead of waiting for the background sweep.
  await pool.query(
    `UPDATE orders SET status = 'expired' WHERE id = $1 AND status = 'pending' AND expires_at <= now()`,
    [id],
  );

  const { rows } = await pool.query(
    `SELECT id, status, total_paise, created_at, expires_at, paid_at, picked_up_at, review_reason,
            CASE WHEN status = 'pending'
                 THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (expires_at - clock_timestamp()))))::int
                 ELSE 0 END AS expires_in_seconds
       FROM orders WHERE id = $1`,
    [id],
  );
  if (!rows.length) return null;
  const o = rows[0];

  const items = await pool.query(
    `SELECT oi.product_id, p.name, oi.quantity, oi.unit_price_paise
       FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 ORDER BY oi.product_id`,
    [id],
  );

  return {
    id: o.id as string,
    status: o.status as OrderStatus,
    totalPaise: o.total_paise as number,
    items: items.rows.map((r) => ({
      productId: r.product_id as number,
      name: r.name as string,
      quantity: r.quantity as number,
      unitPricePaise: r.unit_price_paise as number,
    })),
    createdAt: o.created_at as Date,
    expiresAt: o.expires_at as Date,
    paidAt: o.paid_at as Date | null,
    pickedUpAt: o.picked_up_at as Date | null,
    reviewReason: o.review_reason as string | null,
    expiresInSeconds: o.expires_in_seconds as number,
  };
}

export async function expireStaleOrders(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at <= now()`,
  );
  return rowCount ?? 0;
}

export async function claimPickup(id: string) {
  if (!isUuid(id)) throw new AppError(404, 'ORDER_NOT_FOUND', 'order not found');

  return withTransaction(async (client) => {
    const { rows: items } = await client.query(
      `SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id`,
      [id],
    );
    if (items.length) await lockProducts(client, items.map((i) => i.product_id));

    // The status check and the status change happen in one statement. If two
    // lockers race, the second one waits on the row lock and then finds the
    // order is no longer 'paid', so it updates nothing.
    const claimed = await client.query(
      `UPDATE orders SET status = 'picked_up', picked_up_at = now()
        WHERE id = $1 AND status = 'paid'
        RETURNING id`,
      [id],
    );

    if (claimed.rowCount === 0) {
      const { rows } = await client.query(`SELECT status, expires_at <= now() AS lapsed FROM orders WHERE id = $1`, [id]);
      if (!rows.length) throw new AppError(404, 'ORDER_NOT_FOUND', 'order not found');
      const { status, lapsed } = rows[0];
      if (status === 'picked_up') throw new AppError(409, 'ALREADY_PICKED_UP', 'this order has already been collected');
      if (status === 'expired' || (status === 'pending' && lapsed)) {
        throw new AppError(409, 'ORDER_EXPIRED', 'this order expired before it was paid');
      }
      if (status === 'needs_review') throw new AppError(409, 'ORDER_NEEDS_REVIEW', 'this order is waiting for staff review');
      throw new AppError(409, 'ORDER_NOT_PAID', 'this order has not been paid');
    }

    for (const item of items) {
      await client.query(`UPDATE products SET stock = stock - $2 WHERE id = $1`, [item.product_id, item.quantity]);
    }

    return { id, status: 'picked_up' as const };
  });
}
