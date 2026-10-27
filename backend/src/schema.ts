import { pool } from './db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise > 0),
  stock       INTEGER NOT NULL CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'expired', 'needs_review', 'picked_up')),
  total_paise   INTEGER NOT NULL CHECK (total_paise > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  paid_at       TIMESTAMPTZ,
  picked_up_at  TIMESTAMPTZ,
  review_reason TEXT
);

CREATE INDEX IF NOT EXISTS orders_pending_expiry_idx ON orders (expires_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS order_items (
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL REFERENCES products(id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_paise INTEGER NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items (product_id);

-- One row per provider event. The primary key is what makes webhooks idempotent.
CREATE TABLE IF NOT EXISTS payment_events (
  event_id     TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  status       TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export const SEED_PRODUCTS: Array<[string, number, number]> = [
  ['Masala Chips', 2000, 12],
  ['Chocolate Bar', 4500, 8],
  ['Roasted Peanuts', 1500, 20],
  ['Cold Coffee', 6000, 5],
  ['Coconut Cookies', 3000, 2],
];

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA);
}

export async function seedIfEmpty(): Promise<void> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM products');
  if (rows[0].n > 0) return;
  for (const [name, price, stock] of SEED_PRODUCTS) {
    await pool.query('INSERT INTO products (name, price_paise, stock) VALUES ($1, $2, $3)', [name, price, stock]);
  }
}
