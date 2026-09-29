import { useEffect, useState } from 'react';

/** The time now, moved on every half minute: enough for "scanned 3 minutes ago" to stay true while a page is open. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);
  return now;
}
