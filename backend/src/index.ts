import { buildApp } from './app';
import { config } from './config';
import { pool } from './db';
import { migrate, seedIfEmpty } from './schema';
import { expireStaleOrders } from './services/orders';

async function main() {
  await migrate();
  await seedIfEmpty();

  const server = buildApp().listen(config.port, () => {
    console.log(`API listening on :${config.port}`);
  });

  // Availability never depends on this sweep (queries check expires_at
  // directly); it only keeps the stored status tidy.
  const sweep = setInterval(() => {
    expireStaleOrders()
      .then((n) => n && console.log(`expired ${n} order(s)`))
      .catch((err) => console.error('expiry sweep failed', err));
  }, config.expirySweepMs);

  const shutdown = () => {
    clearInterval(sweep);
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
