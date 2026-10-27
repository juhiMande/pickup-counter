import express from 'express';
import cors from 'cors';
import { errorHandler } from './errors';
import { productsRouter } from './routes/products';
import { ordersRouter } from './routes/orders';
import { paymentsRouter } from './routes/payments';

export function buildApp() {
  const app = express();
  app.use(cors());

  // Mounted before express.json() so the webhook keeps its raw body.
  app.use('/payments', paymentsRouter);

  app.use(express.json({ limit: '50kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/products', productsRouter);
  app.use('/orders', ordersRouter);

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'route not found' } }));
  app.use(errorHandler);
  return app;
}
