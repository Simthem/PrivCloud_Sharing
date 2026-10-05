import { useEffect, useState } from "react";

/**
 * Turns true once the browser is idle after the first render. Hidden UI that
 * waits for it is built ahead of its first use, so the tap revealing it does
 * not also pay for creating it.
 */
const useIdleMount = () => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const prime = () => setReady(true);

    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(prime, { timeout: 1500 });
      return () => window.cancelIdleCallback(idleId);
    }

    const timeout = globalThis.setTimeout(prime, 300);
    return () => globalThis.clearTimeout(timeout);
  }, []);

  return ready;
};

export default useIdleMount;
