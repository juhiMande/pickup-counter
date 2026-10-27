import express, { Router } from 'express';
import { config } from '../config';
import { AppError } from '../errors';
import { isValidSignature } from '../signature';
import { handlePaymentEvent, parsePaymentEvent } from '../services/payments';

export const paymentsRouter = Router();

// The signature is over the exact bytes the provider sent, so this route reads
// the raw body and parses JSON itself only after the signature checks out.
paymentsRouter.post('/webhook', express.raw({ type: '*/*', limit: '100kb' }), async (req, res, next) => {
  try {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!isValidSignature(raw, req.header('x-signature'), config.webhookSecret)) {
      throw new AppError(401, 'INVALID_SIGNATURE', 'signature does not match');
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError(400, 'INVALID_JSON', 'request body is not valid JSON');
    }

    const result = await handlePaymentEvent(parsePaymentEvent(body));
    res.json(result);
  } catch (err) {
    next(err);
  }
});
