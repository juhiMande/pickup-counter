import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, Order, Product } from '../api';
import { rupees } from '../money';

interface Props {
  onOrderPlaced: (order: Order, measuredAt: number) => void;
}

export function Catalog({ onOrderPlaced }: Props) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [cart, setCart] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProducts(await api.products());
    } catch {
      setError('Could not load products. Check that the server is running.');
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  // If availability drops below what is already in the cart, trim the cart.
  useEffect(() => {
    if (!products) return;
    setCart((current) => {
      const next: Record<number, number> = {};
      for (const p of products) {
        const qty = Math.min(current[p.id] ?? 0, p.availableUnits);
        if (qty > 0) next[p.id] = qty;
      }
      return next;
    });
  }, [products]);

  const change = (product: Product, delta: number) => {
    setError(null);
    setCart((current) => {
      const qty = Math.max(0, Math.min(product.availableUnits, (current[product.id] ?? 0) + delta));
      const next = { ...current, [product.id]: qty };
      if (qty === 0) delete next[product.id];
      return next;
    });
  };

  const lines = (products ?? []).filter((p) => cart[p.id]);
  const total = lines.reduce((sum, p) => sum + p.pricePaise * cart[p.id], 0);

  const placeOrder = async () => {
    setPlacing(true);
    setError(null);
    try {
      const { data, measuredAt } = await api.placeOrder(lines.map((p) => ({ productId: p.id, quantity: cart[p.id] })));
      setCart({});
      onOrderPlaced(data, measuredAt);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK') {
        setError('Someone just bought some of these. Your cart has been updated, please check it and try again.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not place the order.');
      }
      refresh();
    } finally {
      setPlacing(false);
    }
  };

  if (!products) return <p className="muted">{error ?? 'Loading products…'}</p>;

  return (
    <div className="catalog">
      <ul className="products">
        {products.map((p) => {
          const inCart = cart[p.id] ?? 0;
          const soldOut = p.availableUnits === 0;
          return (
            <li key={p.id} className={soldOut ? 'product sold-out' : 'product'}>
              <div>
                <strong>{p.name}</strong>
                <span className="price">{rupees(p.pricePaise)}</span>
                <span className="muted">{soldOut ? 'Sold out' : `${p.availableUnits} left`}</span>
              </div>
              <div className="stepper">
                <button onClick={() => change(p, -1)} disabled={inCart === 0} aria-label={`Remove one ${p.name}`}>
                  −
                </button>
                <span aria-live="polite">{inCart}</span>
                <button onClick={() => change(p, 1)} disabled={inCart >= p.availableUnits} aria-label={`Add one ${p.name}`}>
                  +
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <aside className="cart">
        <h2>Your order</h2>
        {lines.length === 0 ? (
          <p className="muted">Add something to get started.</p>
        ) : (
          <table>
            <tbody>
              {lines.map((p) => (
                <tr key={p.id}>
                  <td>
                    {cart[p.id]} × {p.name}
                  </td>
                  <td className="num">{rupees(p.pricePaise * cart[p.id])}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="num">{rupees(total)}</td>
              </tr>
            </tfoot>
          </table>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" onClick={placeOrder} disabled={lines.length === 0 || placing}>
          {placing ? 'Placing order…' : 'Place order and pay'}
        </button>
      </aside>
    </div>
  );
}
