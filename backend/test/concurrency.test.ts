import {
  addProduct, app, availableUnits, payOrder, placeOrder, pool, productRow, request, resetDb, setupDb, sendWebhook,
} from './helpers';

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(() => pool.end());

describe('ordering the last units under contention', () => {
  it('ten customers racing for the last two units: exactly two get them', async () => {
    const productId = await addProduct('Last Cookies', 3000, 2);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => placeOrder([{ productId, quantity: 1 }])),
    );

    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status !== 201);

    expect(created).toHaveLength(2);
    expect(rejected).toHaveLength(8);
    for (const r of rejected) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    }

    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(oi.quantity), 0)::int AS held, count(DISTINCT o.id)::int AS orders
         FROM orders o JOIN order_items oi ON oi.order_id = o.id`,
    );
    expect(rows[0]).toEqual({ held: 2, orders: 2 });
    expect(await availableUnits(productId)).toBe(0);
    expect((await productRow(productId)).stock).toBe(2);
  });

  it('a failed order holds nothing, even when part of it could be filled', async () => {
    const plenty = await addProduct('Chips', 2000, 10);
    const scarce = await addProduct('Coffee', 6000, 1);

    const res = await placeOrder([
      { productId: plenty, quantity: 3 },
      { productId: scarce, quantity: 2 },
    ]);

    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual([{ productId: scarce, requested: 2, available: 1 }]);
    expect(await availableUnits(plenty)).toBe(10);
    expect(await availableUnits(scarce)).toBe(1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
    expect(rows[0].n).toBe(0);
  });
});

describe('webhook idempotency', () => {
  it('the same event delivered twice is processed once', async () => {
    const productId = await addProduct('Chocolate', 4500, 5);
    const order = (await placeOrder([{ productId, quantity: 1 }])).body;
    const event = { eventId: 'evt_dup_1', orderId: order.id, amountPaise: 4500, status: 'captured' };

    const first = await sendWebhook(event);
    const afterFirst = (await request(app).get(`/orders/${order.id}`)).body;
    const second = await sendWebhook(event);
    const afterSecond = (await request(app).get(`/orders/${order.id}`)).body;

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ duplicate: false, outcome: 'paid' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ duplicate: true, outcome: 'paid' });

    expect(afterFirst.status).toBe('paid');
    expect(afterSecond).toEqual(afterFirst);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM payment_events');
    expect(rows[0].n).toBe(1);
  });

  it('the same event delivered twice at the same moment is processed once', async () => {
    const productId = await addProduct('Chocolate', 4500, 5);
    const order = (await placeOrder([{ productId, quantity: 1 }])).body;
    const event = { eventId: 'evt_dup_2', orderId: order.id, amountPaise: 4500, status: 'captured' };

    const results = await Promise.all([sendWebhook(event), sendWebhook(event)]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(results.filter((r) => r.body.duplicate === true)).toHaveLength(1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM payment_events');
    expect(rows[0].n).toBe(1);
  });
});

describe('pickup claims', () => {
  it('two lockers claiming the same order at the same moment: exactly one succeeds', async () => {
    const productId = await addProduct('Peanuts', 1500, 5);
    const order = (await placeOrder([{ productId, quantity: 2 }])).body;
    await payOrder(order.id, order.totalPaise);

    const results = await Promise.all([
      request(app).post(`/orders/${order.id}/pickup-claim`),
      request(app).post(`/orders/${order.id}/pickup-claim`),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('ALREADY_PICKED_UP');

    expect((await productRow(productId)).stock).toBe(3);
    expect(await availableUnits(productId)).toBe(3);
  });
});
