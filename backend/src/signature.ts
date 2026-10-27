import crypto from 'crypto';

export function sign(rawBody: Buffer | string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function isValidSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !/^[0-9a-f]+$/i.test(header)) return false;
  const expected = Buffer.from(sign(rawBody, secret), 'hex');
  const received = Buffer.from(header, 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
