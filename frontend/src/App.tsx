import { useState } from 'react';
import { Order } from './api';
import { Catalog } from './components/Catalog';
import { Payment } from './components/Payment';

interface ActiveOrder {
  order: Order;
  measuredAt: number;
}

export function App() {
  const [active, setActive] = useState<ActiveOrder | null>(null);

  return (
    <main className="shell">
      <header className="masthead">
        <h1>Pickup Counter</h1>
        <p>Pick your snacks, pay by UPI, collect from the locker.</p>
      </header>
      {active ? (
        <Payment initial={active.order} initialMeasuredAt={active.measuredAt} onDone={() => setActive(null)} />
      ) : (
        <Catalog onOrderPlaced={(order, measuredAt) => setActive({ order, measuredAt })} />
      )}
    </main>
  );
}
