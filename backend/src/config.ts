function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL', 'postgres://pickup:pickup@localhost:5432/pickup'),
  webhookSecret: required('WEBHOOK_SECRET', 'dev-webhook-secret'),
  holdSeconds: Number(process.env.HOLD_SECONDS ?? 120),
  expirySweepMs: Number(process.env.EXPIRY_SWEEP_MS ?? 5000),
};
