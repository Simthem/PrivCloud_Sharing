import { useEffect, useState } from "react";

/**
 * Changes each time the personal E2E key is loaded or removed in this tab,
 * so the effects that opened keys from it run again.
 */
export default function useUserKeyGeneration() {
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const bump = () => setGeneration((value) => value + 1);
    window.addEventListener("e2e-key-stored", bump);
    window.addEventListener("e2e-key-removed", bump);
    return () => {
      window.removeEventListener("e2e-key-stored", bump);
      window.removeEventListener("e2e-key-removed", bump);
    };
  }, []);
  return generation;
}
