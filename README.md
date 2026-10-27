# Pickup Counter

A self-service snack counter: pick items, pay by UPI (simulated webhook), collect from a locker.

- **Backend:** Node.js + Express + TypeScript, PostgreSQL (plain SQL through `pg`, no ORM)
- **Frontend:** React + Vite + TypeScript, served by nginx in Docker
- **Tests:** Jest + Supertest against a real PostgreSQL database

## Running it

Requirements: Docker with Compose v2.

```bash
docker compose up --build
```

| What        | Where                   |
|-------------|-------------------------|
| Customer UI | http://localhost:8080   |
| API         | http://localhost:3000   |
| Postgres    | localhost:5432 (pickup / pickup) |

Tables are created and five products seeded when the backend starts.

### Trying a payment

1. Open http://localhost:8080, add items, click **Place order and pay**.
2. The payment screen shows the full order id under "Testing without a real payment provider". In another terminal:

```bash
# correct amount (looked up from the order), random event id
docker compose exec backend npm run send-webhook -- <orderId>

# explicit amount / event id / status
docker compose exec backend npm run send-webhook -- <orderId> 4500 evt_123 captured

# wrong amount -> needs_review
docker compose exec backend npm run send-webhook -- <orderId> 1
```

Running the same command twice with the same event id shows the duplicate being ignored.

3. Simulate a locker:

```bash
curl -X POST http://localhost:3000/orders/<orderId>/pickup-claim
```

The hold length can be shortened for manual testing: `HOLD_SECONDS=20 docker compose up --build`.

### Running the tests

The tests need Postgres, which compose provides (a separate `pickup_test` database is created on first start):

```bash
docker compose --profile test run --rm tests
```

Or locally, with Postgres from compose running:

```bash
cd backend
npm install
DATABASE_URL=postgres://pickup:pickup@localhost:5432/pickup_test npm test
```

> If you already had a `pgdata` volume from an earlier run, the test DB will not exist. Either
> `docker compose down -v` once, or `docker compose exec db createdb -U pickup pickup_test`.

## API

| Method | Path | Notes |
|---|---|---|
| GET  | `/products` | each product with `availableUnits` = stock − units held by live orders |
| POST | `/orders` | `{ "items": [{ "productId": 1, "quantity": 2 }] }` → 201 with order and `expiresInSeconds`; 409 `INSUFFICIENT_STOCK` (with per-item details) |
| GET  | `/orders/:id` | order status, used by the screen for polling |
| POST | `/payments/webhook` | requires `X-Signature` (hex HMAC-SHA256 of raw body); 401 if it does not match |
| POST | `/orders/:id/pickup-claim` | 200 once; 409 `ALREADY_PICKED_UP`, `ORDER_NOT_PAID`, `ORDER_EXPIRED`, `ORDER_NEEDS_REVIEW` |

Errors always look like `{ "error": { "code": "...", "message": "..." } }`.

## How correctness is handled

**Holds are not a separate counter.** An order holds units while it is `pending` and `expires_at` is in the future, or while it is `paid` and not yet picked up. Available units are computed from that every time. Because expiry is just a timestamp comparison, a hold is released the instant it runs out, even if the background job that flips `pending → expired` has not run yet. The job (every 5 s) and a check on `GET /orders/:id` only keep the stored status tidy.

**Ordering the last units.** Creating an order locks the product rows (`SELECT … FOR UPDATE`, in id order), then counts held units, then inserts. Concurrent orders for the same product queue on that lock, so each one sees the holds created by the ones before it. If any line is short, the whole transaction is rolled back and nothing is held.

**Lock order.** Every path that touches stock locks product rows first (in id order), then the order row. This avoids deadlocks between, for example, a late webhook and a pickup claim on the same order.

**Webhook idempotency.** The first thing the handler does is insert the `eventId` into `payment_events` (primary key) with `ON CONFLICT DO NOTHING`, inside the same transaction as the order update. A repeat, even one arriving at the same moment, either waits and then conflicts or finds the row already there, and returns `{ duplicate: true }` with the original outcome. Every event is stored with its outcome, which doubles as an audit log.

**Pickup.** `UPDATE orders SET status = 'picked_up' WHERE id = $1 AND status = 'paid'` is the check and the change in one statement. The second of two racing lockers waits on the row lock, then finds the status is no longer `paid` and gets 409. Stock is reduced in the same transaction, and `stock >= 0` is also a database `CHECK` as a last line of defence.

**Money** is stored and compared as integer paise everywhere; it is only formatted as rupees in the UI.

**Countdown with a wrong clock.** The server returns `expiresInSeconds`, computed from the database clock. The screen never uses `Date.now()`; it anchors that number to `performance.now()` (monotonic, not affected by the wall clock) at the midpoint of the request, counts down locally, and re-anchors on every 2 s poll. So a counter whose clock is minutes off still shows the right time, and drift cannot build up. When the countdown hits zero the screen keeps polling until the server says `expired`, so the server always has the final word.

## Decisions on open questions

### Late payment (valid capture after the hold expired)

The money has already left the customer's account, so the friendliest outcome is to honour the order when possible:

- **Units still available** (nobody took them in the meantime): mark the order `paid` and hold the units again. Outcome `late_payment_accepted`.
- **Units gone:** mark the order `needs_review` with reason `late_payment_no_stock`, and do not touch anyone else's order. Staff refund it. The customer screen tells them to show their order code to staff.

The availability check for a late payment runs under the same product locks as order creation, so it can never oversell. I chose not to "reserve harder" (e.g. extend holds while a payment might be in flight) because a 120 s hold is already the contract, and an occasional refund is better than stock getting stuck behind payments that never arrive.

### Other choices

- **Amount mismatch** → `needs_review` (reason `amount_mismatch`). A `needs_review` order does **not** keep holding stock: it may never be resolved, and stock locked forever is worse than a staff member re-placing the order. Staff see the reason on the order and the amount on the event.
- **Second successful payment for an already paid / picked-up / in-review order** (different event id): the order is not changed; the event is stored with outcome `already_settled` so it can be refunded.
- **Events with a status other than `captured`** (e.g. `failed`) are recorded and ignored. The order expires normally.
- **Unknown order id** in a validly signed event: recorded as `unknown_order`, 200 returned so the provider stops retrying.
- **Webhook responses:** 200 for every authentic, well-formed event (including duplicates), 401 for bad/missing signature, 400 for malformed JSON or fields. A 5xx is only returned for real server errors, which is what should make a provider retry.
- **Pickup of an unpaid / expired / in-review order** returns 409 with a specific code, since it is a state conflict rather than a bad request.

## Assumptions

- One currency (INR), prices fixed at the time the order is placed (stored per line).
- At most 20 units of one product per order; duplicate product ids in one request are merged.
- The webhook secret is shared via `WEBHOOK_SECRET` (default `dev-webhook-secret` in compose; set your own in `.env`).
- The locker only needs the order id; there is no locker authentication in this version.
- A single API instance. Nothing depends on in-memory state, so running several would also be correct; the expiry sweep is just a harmless idempotent `UPDATE`.

## Testing

`backend/test/concurrency.test.ts` covers the three required cases:

- 10 parallel orders for the last 2 units → exactly 2 created, 8 fail with 409, exactly 2 units held, stock unchanged.
- Same webhook event twice, both one after another and at the same moment → one `payment_events` row, order unchanged by the repeat.
- Two parallel pickup claims → one 200, one 409, stock reduced exactly once.

`backend/test/rules.test.ts` covers the rest: totals and `expiresInSeconds`, input validation, hold expiry releasing stock, bad signatures, amount mismatch, both late-payment branches, double payment, and pickup of unpaid/expired orders.

I also ran the suite repeatedly to check the concurrency tests are not flaky, and tried the full flow by hand with the UI, the webhook script and curl.

## What I would do next

- Staff endpoints for `needs_review` orders (resolve as paid, mark refunded) and a refund record.
- Locker authentication and a pickup code shown to the customer instead of the raw order id.
- Store the provider's raw payload and signature header for audits.
- Frontend tests for the countdown (fake `performance.now()`), and an end-to-end test with Playwright.
- Proper migrations (e.g. node-pg-migrate) instead of `CREATE TABLE IF NOT EXISTS` on boot.
- Rate limiting on `POST /orders` so one client cannot hold all stock with throwaway orders.
- Structured logging and metrics (holds created/expired, webhook outcomes).
