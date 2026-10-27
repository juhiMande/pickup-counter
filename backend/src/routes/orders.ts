import { Router } from 'express';
import { AppError } from '../errors';
import { claimPickup, createOrder, getOrder, parseOrderItems } from '../services/orders';

export const ordersRouter = Router();

ordersRouter.post('/', async (req, res, next) => {
  try {
    const items = parseOrderItems(req.body);
    res.status(201).json(await createOrder(items));
  } catch (err) {
    next(err);
  }
});

ordersRouter.get('/:id', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'order not found');
    res.json(order);
  } catch (err) {
    next(err);
  }
});

ordersRouter.post('/:id/pickup-claim', async (req, res, next) => {
  try {
    res.json(await claimPickup(req.params.id));
  } catch (err) {
    next(err);
  }
});
