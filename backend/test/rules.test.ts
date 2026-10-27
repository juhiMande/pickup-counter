import {
  addProduct, app, availableUnits, expireHold, payOrder, placeOrder, pool, request, resetDb, setupDb, sendWebhook,
} from './helpers';
import { expireStaleOrders } from '../src/services/orders';

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(() => pool.end());

describe('orders', () => {
  it('computes the total in paise and reports the hold time', async () => {
    const a = await addProduct('Chips', 2000, 10);
    const b = await addProduct('Coffee', 6000, 10);

    const res = await placeOrder([{ productId: a, quantity: 2 }, { productId: b, quantity: 1 }]);

    expect(res.status).toBe(201);
    expect(res.body.totalPaise).toBe(10000);
    expect(res.body.status).toBe('pending');
    expect(res.body.expiresInSeconds).toBeGreaterThanOrEqual(118);
    expect(res.body.expiresInSeconds).toBeLessThanOrEqual(120);
    expect(await availableUnits(a)).toBe(8);
  });

  it('rejects bad input', async () => {
    const id = await addProduct('Chips', 2000, 10);
    expect((await placeOrder([])).status).toBe(400);
    expect((await placeOrder([{ productId: id, quantity: 0 }])).status).toBe(400);
    expect((await placeOrder([{ productId: id, quantity: 1.5 }])).status).toBe(400);
    expect((await placeOrder([{ productId: 999, quantity: 1 }])).body.error.code).toBe('UNKNOWN_PRODUCT');
  });

  it('an expired hold releases its units and shows as expired', async () => {
    const id = await addProduct('Chips', 2000, 3);
    const order = (await placeOrder([{ productId: id, quantity: 3 }])).body;
    expect(await availableUnits(id)).toBe(0);

    await expireHold(order.id);
    expect(await availableUnits(id)).toBe(3);

    const view = (await request(app).get(`/orders/${order.id}`)).body;
    expect(view.status).toBe('expired');
    expect(view.expiresInSeconds).toBe(0);
  });

  it('the background sweep marks stale orders expired', async () => {
    const id = await addProduct('Chips', 2000, 3);
    const order = (await placeOrder([{ productId: id, quantity: 1 }])).body;
    await expireHold(order.id);
    expect(await expireStaleOrders()).toBe(1);
    const { rows } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    expect(rows[0].status).toBe('expired');
  });
});

describe('payment webhook', () => {
  it('rejects a bad signature and changes nothing', async () => {
    const id = await addProduct('Chips', 2000, 3);
    const order = (await placeOrder([{ productId: id, quantity: 1 }])).body;

    const res = await sendWebhook({ eventId: 'e1', orderId: order.id, amountPaise: 2000, status: 'captured' }, 'wrong');
    expect(res.status).toBe(401);

    const missing = await request(app).post('/payments/webhook').set('Content-Type', 'application/json')
      .send(JSON.stringify({ eventId: 'e1', orderId: order.id, amountPaise: 2000, status: 'captured' }));
    expect(missing.status).toBe(401);

    expect((await request(app).get(`/orders/${order.id}`)).body.status).toBe('pending');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM payment_events');
    expect(rows[0].n).toBe(0);
  });

  it('a wrong amount sends the order to review instead of paid', async () => {
    const id = await addProduct('Chips', 2000, 3);
    const order = (await placeOrder([{ productId: id, quantity: 1 }])).body;

    const res = await payOrder(order.id, 1999);
    expect(res.body.outcome).toBe('amount_mismatch');

    const view = (await request(app).get(`/orders/${order.id}`)).body;
    expect(view.status).toBe('needs_review');
    expect(view.reviewReason).toBe('amount_mismatch');
  });

  it('a late payment is accepted when the units are still free', async () => {
    const id = await addProduct('Chips', 2000, 3);
    const order = (await placeOrder([{ productId: id, quantity: 2 }])).body;
    await expireHold(order.id);

    const res = await payOrder(order.id, 4000);
    expect(res.body.outcome).toBe('late_payment_accepted');
    expect((await request(app).get(`/orders/${order.id}`)).body.status).toBe('paid');
    expect(await availableUnits(id)).toBe(1);
  });

  it('a late payment goes to review when the units were sold to someone else', async () => {
    const id = await addProduct('Chips', 2000, 2);
    const late = (await placeOrder([{ productId: id, quantity: 2 }])).body;
    await expireHold(late.id);
    const other = (await placeOrder([{ productId: id, quantity: 1 }])).body;
    expect(other.status).toBe('pending');

    const res = await payOrder(late.id, 4000);
    expect(res.body.outcome).toBe('late_payment_no_stock');

    const view = (await request(app).get(`/orders/${late.id}`)).body;
    expect(view.status).toBe('needs_review');
    expect(view.reviewReason).toBe('late_payment_no_stock');
    expect(await availableUnits(id)).toBe(1);
  });

  it('a second, different payment for a paid order is logged but changes nothing', async () => {
    const id = await addProduct('Chips', 2000, 3);
    const order = (await placeOrder([{ productId: id, quantity: 1 }])).body;
    await payOrder(order.id, 2000, 'evt_a');
    const res = await payOrder(order.id, 2000, 'evt_b');
    expect(res.body.outcome).toBe('already_settled');
    expect((await request(app).get(`/orders/${order.id}`)).body.status).toBe('paid');
  });
});

describe('pickup rules', () => {
  it('an unpaid or expired order cannot be claimed', async () => {
    const id = await addProduct('Chips', 2000, 3);
    const order = (await placeOrder([{ productId: id, quantity: 1 }])).body;

    const unpaid = await request(app).post(`/orders/${order.id}/pickup-claim`);
    expect(unpaid.status).toBe(409);
    expect(unpaid.body.error.code).toBe('ORDER_NOT_PAID');

    await expireHold(order.id);
    const expired = await request(app).post(`/orders/${order.id}/pickup-claim`);
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('ORDER_EXPIRED');
  });

  it('an unknown order returns 404', async () => {
    const res = await request(app).post('/orders/00000000-0000-0000-0000-000000000000/pickup-claim');
    expect(res.status).toBe(404);
  });
});
