import { withTransaction } from '../db';
import { AppError } from '../errors';
import { heldUnits, lockProducts } from './stock';
import { isUuid } from './orders';

export interface PaymentEvent {
  eventId: string;
  orderId: string;
  amountPaise: number;
  status: string;
}

export type WebhookOutcome =
  | 'paid'
  | 'late_payment_accepted'
  | 'late_payment_no_stock'
  | 'amount_mismatch'
  | 'already_settled'
  | 'ignored_status'
  | 'unknown_order';

export function parsePaymentEvent(body: unknown): PaymentEvent {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.eventId !== 'string' || !b.eventId || b.eventId.length > 200) {
    throw new AppError(400, 'INVALID_EVENT', 'eventId must be a non-empty string');
  }
  if (typeof b.orderId !== 'string' || !b.orderId) {
    throw new AppError(400, 'INVALID_EVENT', 'orderId must be a non-empty string');
  }
  if (!Number.isInteger(b.amountPaise) || (b.amountPaise as number) < 0) {
    throw new AppError(400, 'INVALID_EVENT', 'amountPaise must be a non-negative integer');
  }
  if (typeof b.status !== 'string') {
    throw new AppError(400, 'INVALID_EVENT', 'status must be a string');
  }
  return { eventId: b.eventId, orderId: b.orderId, amountPaise: b.amountPaise as number, status: b.status };
}

export async function handlePaymentEvent(event: PaymentEvent) {
  return withTransaction(async (client) => {
    // Record the event first. If the same eventId arrives twice (even at the
    // same moment), the second insert waits for the first transaction and then
    // hits the primary key, so only one delivery ever does any work.
    const inserted = await client.query(
      `INSERT INTO payment_events (event_id, order_id, amount_paise, status, outcome)
       VALUES ($1, $2, $3, $4, 'processing')
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.eventId, event.orderId, event.amountPaise, event.status],
    );

    if (inserted.rowCount === 0) {
      const prev = await client.query(`SELECT outcome FROM payment_events WHERE event_id = $1`, [event.eventId]);
      return { duplicate: true, outcome: prev.rows[0]?.outcome as WebhookOutcome };
    }

    const outcome = await applyEvent(client, event);
    await client.query(`UPDATE payment_events SET outcome = $2 WHERE event_id = $1`, [event.eventId, outcome]);
    return { duplicate: false, outcome };
  });
}

type Client = Parameters<Parameters<typeof withTransaction>[0]>[0];

async function applyEvent(client: Client, event: PaymentEvent): Promise<WebhookOutcome> {
  if (!isUuid(event.orderId)) return 'unknown_order';

  // Lock order: products first, then the order row (same as pickup).
  const { rows: items } = await client.query(
    `SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id`,
    [event.orderId],
  );
  if (items.length) await lockProducts(client, items.map((i) => i.product_id));

  const { rows } = await client.query(
    `SELECT id, status, total_paise, expires_at > now() AS in_hold FROM orders WHERE id = $1 FOR UPDATE`,
    [event.orderId],
  );
  if (!rows.length) return 'unknown_order';
  const order = rows[0];

  if (event.status !== 'captured') return 'ignored_status';

  // A second successful payment for an order that is already settled. We do
  // not touch the order; the event row is the record staff use for a refund.
  if (order.status === 'paid' || order.status === 'picked_up' || order.status === 'needs_review') {
    return 'already_settled';
  }

  if (event.amountPaise !== order.total_paise) {
    await markNeedsReview(client, order.id, 'amount_mismatch');
    return 'amount_mismatch';
  }

  if (order.status === 'pending' && order.in_hold) {
    await markPaid(client, order.id);
    return 'paid';
  }

  // Late payment: the hold ran out before the money arrived. If the units are
  // still free we honour the order; if not, it goes to staff for a refund.
  const productIds = items.map((i) => i.product_id as number);
  const stock = new Map(
    (await client.query(`SELECT id, stock FROM products WHERE id = ANY($1::int[])`, [productIds])).rows.map((r) => [
      r.id as number,
      r.stock as number,
    ]),
  );
  const held = await heldUnits(client, productIds, order.id);
  const enough = items.every(
    (i) => (stock.get(i.product_id) ?? 0) - (held.get(i.product_id) ?? 0) >= i.quantity,
  );

  if (enough) {
    await markPaid(client, order.id);
    return 'late_payment_accepted';
  }
  await markNeedsReview(client, order.id, 'late_payment_no_stock');
  return 'late_payment_no_stock';
}

async function markPaid(client: Client, orderId: string) {
  await client.query(`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1`, [orderId]);
}

async function markNeedsReview(client: Client, orderId: string, reason: string) {
  await client.query(`UPDATE orders SET status = 'needs_review', review_reason = $2 WHERE id = $1`, [orderId, reason]);
}
