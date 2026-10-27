import { PoolClient } from 'pg';
import { pool } from '../db';

// Units count as "held" while an order is pending and inside its hold window,
// or after it has been paid but not yet collected. Expired, needs_review and
// picked_up orders hold nothing (picked_up has already been taken off stock).
const HELD_CONDITION = `(o.status = 'paid' OR (o.status = 'pending' AND o.expires_at > now()))`;

type Queryable = Pick<PoolClient, 'query'>;

export async function heldUnits(
  db: Queryable,
  productIds: number[],
  excludeOrderId: string | null = null,
): Promise<Map<number, number>> {
  const { rows } = await db.query(
    `SELECT oi.product_id, SUM(oi.quantity)::int AS held
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = ANY($1::int[])
        AND ${HELD_CONDITION}
        AND ($2::uuid IS NULL OR o.id <> $2::uuid)
      GROUP BY oi.product_id`,
    [productIds, excludeOrderId],
  );
  return new Map(rows.map((r) => [r.product_id as number, r.held as number]));
}

// Every code path that changes stock or holds locks the product rows first,
// always in id order, so concurrent requests queue up instead of deadlocking.
export async function lockProducts(db: Queryable, productIds: number[]) {
  const { rows } = await db.query(
    `SELECT id, name, price_paise, stock FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
    [productIds],
  );
  return rows as Array<{ id: number; name: string; price_paise: number; stock: number }>;
}

export async function listProducts() {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.price_paise, p.stock,
            p.stock - COALESCE(h.held, 0) AS available
       FROM products p
       LEFT JOIN (
         SELECT oi.product_id, SUM(oi.quantity)::int AS held
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE ${HELD_CONDITION}
          GROUP BY oi.product_id
       ) h ON h.product_id = p.id
      ORDER BY p.id`,
  );
  return rows.map((r) => ({
    id: r.id as number,
    name: r.name as string,
    pricePaise: r.price_paise as number,
    stock: r.stock as number,
    availableUnits: Number(r.available),
  }));
}
