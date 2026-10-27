import request from 'supertest';
import { buildApp } from '../src/app';
import { pool } from '../src/db';
import { migrate } from '../src/schema';
import { sign } from '../src/signature';
import { config } from '../src/config';

export const app = buildApp();

export async function setupDb() {
  await migrate();
}

export async function resetDb() {
  await pool.query('TRUNCATE payment_events, order_items, orders, products RESTART IDENTITY CASCADE');
}

export async function addProduct(name: string, pricePaise: number, stock: number): Promise<number> {
  const { rows } = await pool.query(
    'INSERT INTO products (name, price_paise, stock) VALUES ($1, $2, $3) RETURNING id',
    [name, pricePaise, stock],
  );
  return rows[0].id;
}

export async function placeOrder(items: Array<{ productId: number; quantity: number }>) {
  return request(app).post('/orders').send({ items });
}

export function sendWebhook(payload: object, secret = config.webhookSecret) {
  const body = JSON.stringify(payload);
  return request(app)
    .post('/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Signature', sign(body, secret))
    .send(body);
}

export async function payOrder(orderId: string, amountPaise: number, eventId = `evt_${orderId}`) {
  return sendWebhook({ eventId, orderId, amountPaise, status: 'captured' });
}

export async function expireHold(orderId: string) {
  await pool.query(`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = $1`, [orderId]);
}

export async function productRow(id: number) {
  const { rows } = await pool.query('SELECT stock FROM products WHERE id = $1', [id]);
  return rows[0] as { stock: number };
}

export async function availableUnits(id: number): Promise<number> {
  const res = await request(app).get('/products');
  return res.body.find((p: { id: number }) => p.id === id).availableUnits;
}

export { pool, request };
