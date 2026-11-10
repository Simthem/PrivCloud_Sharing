import { useEffect, useState } from "react";
import authService from "../services/auth.service";

/** Sign-in providers to offer, empty until loaded or when not `enabled`. */
const useOAuthProviders = (enabled: boolean) => {
  const [providers, setProviders] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    authService
      .getAvailableOAuth()
      .then((response) => {
        if (!cancelled) setProviders(response.data);
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return enabled ? providers : [];
};

export default useOAuthProviders;
