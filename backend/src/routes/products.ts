import { Router } from 'express';
import { listProducts } from '../services/stock';

export const productsRouter = Router();

productsRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await listProducts());
  } catch (err) {
    next(err);
  }
});
