import { useEffect, useState } from 'react';
import { api, Order } from '../api';
import { rupees } from '../money';
import { useCountdown } from '../useCountdown';

interface Props {
  initial: Order;
  initialMeasuredAt: number;
  onDone: () => void;
}

const POLL_MS = 2000;

export function Payment({ initial, initialMeasuredAt, onDone }: Props) {
  const [order, setOrder] = useState(initial);
  const [measuredAt, setMeasuredAt] = useState(initialMeasuredAt);
  const [offline, setOffline] = useState(false);
  const remaining = useCountdown(order.expiresInSeconds, measuredAt);

  useEffect(() => {
    if (order.status !== 'pending') return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const { data, measuredAt } = await api.order(order.id);
        if (stopped) return;
        setOffline(false);
        setOrder(data);
        setMeasuredAt(measuredAt);
      } catch {
        if (!stopped) setOffline(true);
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [order.id, order.status]);

  if (order.status === 'paid' || order.status === 'picked_up') {
    return (
      <Result tone="ok" title="Payment received" onDone={onDone}>
        Collect your order from the locker. Your order code is <code>{shortCode(order.id)}</code>.
      </Result>
    );
  }
  if (order.status === 'expired') {
    return (
      <Result tone="warn" title="Time ran out" onDone={onDone}>
        We did not receive the payment in time, so the items have been released. You have not been charged for this
        order. If money did leave your account, show code <code>{shortCode(order.id)}</code> to staff.
      </Result>
    );
  }
  if (order.status === 'needs_review') {
    return (
      <Result tone="warn" title="Payment needs a quick check" onDone={onDone}>
        {order.reviewReason === 'late_payment_no_stock'
          ? 'Your payment arrived after the hold ended and the items were sold. '
          : 'The amount received does not match the order total. '}
        Please show code <code>{shortCode(order.id)}</code> to staff and they will sort it out or refund you.
      </Result>
    );
  }

  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, '0');

  return (
    <section className="payment">
      <div className="pay-box">
        <p className="muted">Pay with any UPI app</p>
        <p className="amount">{rupees(order.totalPaise)}</p>
        <div className="qr" aria-label="UPI QR code placeholder">UPI QR</div>
        <p className={remaining <= 20 ? 'timer urgent' : 'timer'} aria-live="off">
          {remaining > 0 ? `${mm}:${ss} left to pay` : 'Checking payment…'}
        </p>
        {offline && <p className="error">Connection lost, retrying…</p>}
      </div>

      <div className="summary">
        <h2>Order {shortCode(order.id)}</h2>
        <ul>
          {order.items.map((i) => (
            <li key={i.productId}>
              {i.quantity} × {i.name} <span className="num">{rupees(i.quantity * i.unitPricePaise)}</span>
            </li>
          ))}
        </ul>
        <details className="dev-hint">
          <summary>Testing without a real payment provider</summary>
          <p>Send a signed webhook for this order:</p>
          <pre>docker compose exec backend npm run send-webhook -- {order.id}</pre>
        </details>
      </div>
    </section>
  );
}

function Result(props: { tone: 'ok' | 'warn'; title: string; children: React.ReactNode; onDone: () => void }) {
  return (
    <section className={`result ${props.tone}`}>
      <h2>{props.title}</h2>
      <p>{props.children}</p>
      <button className="primary" onClick={props.onDone}>
        Start a new order
      </button>
    </section>
  );
}

function shortCode(id: string) {
  return id.slice(0, 8).toUpperCase();
}
