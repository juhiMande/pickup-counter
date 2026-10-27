// Sends a correctly signed payment webhook to the API.
//
//   npm run send-webhook -- <orderId> [amountPaise] [eventId] [status]
//
// amountPaise defaults to the order total (looked up from the API),
// eventId defaults to a random one, status defaults to "captured".
import crypto from 'crypto';
import { sign } from '../src/signature';

const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
const secret = process.env.WEBHOOK_SECRET ?? 'dev-webhook-secret';

async function main() {
  const [orderId, amountArg, eventIdArg, statusArg] = process.argv.slice(2);
  if (!orderId) {
    console.error('usage: npm run send-webhook -- <orderId> [amountPaise] [eventId] [status]');
    process.exit(1);
  }

  let amountPaise = amountArg !== undefined ? Number(amountArg) : NaN;
  if (Number.isNaN(amountPaise)) {
    const res = await fetch(`${apiUrl}/orders/${orderId}`);
    if (!res.ok) {
      console.error(`could not load order ${orderId}: HTTP ${res.status}`);
      process.exit(1);
    }
    amountPaise = (await res.json()).totalPaise;
  }

  const body = JSON.stringify({
    eventId: eventIdArg ?? `evt_${crypto.randomBytes(6).toString('hex')}`,
    orderId,
    amountPaise,
    status: statusArg ?? 'captured',
  });

  const res = await fetch(`${apiUrl}/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': sign(body, secret) },
    body,
  });

  console.log(`sent: ${body}`);
  console.log(`HTTP ${res.status}: ${await res.text()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
