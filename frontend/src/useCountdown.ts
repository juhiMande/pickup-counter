import { useEffect, useState } from 'react';

// The counter's wall clock may be minutes off, so Date.now() is never used here.
// The server tells us how many seconds are left; we anchor that to
// performance.now(), which is monotonic and unaffected by clock changes, and
// count down from there. Each poll re-anchors, so drift cannot build up.
export function useCountdown(secondsLeft: number, measuredAt: number): number {
  const compute = () => Math.max(0, Math.ceil(secondsLeft - (performance.now() - measuredAt) / 1000));
  const [remaining, setRemaining] = useState(compute);

  useEffect(() => {
    setRemaining(compute());
    const timer = setInterval(() => setRemaining(compute()), 250);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, measuredAt]);

  return remaining;
}
