import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import useUser from "./user.hook";
import teamService from "../services/team.service";
import {
  exportKeyToBase64,
  getUserKey,
  importKeyFromBase64,
  unwrapReverseShareKey,
} from "../utils/crypto.util";

/** Open K_team locally. The shared query cache contains only the wrapped key. */
export default function useTeamKey(teamId: string | undefined, enabled = true) {
  const { user } = useUser();
  const masterKey = getUserKey();
  const active = enabled && !!teamId && !!user && !!masterKey;
  const { data } = useQuery({
    queryKey: ["team", teamId, "wrapped-key", user?.id],
    queryFn: () => teamService.getTeamKey(teamId!),
    enabled: active,
    staleTime: 30_000,
    retry: false,
  });
  const wrappedKey = data?.wrappedTeamKey;
  const [opened, setOpened] = useState<{
    teamId: string;
    masterKey: string;
    wrappedKey: string;
    key: string;
  } | null>(null);
  useEffect(() => {
    if (!active || !teamId || !masterKey || !wrappedKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const master = await importKeyFromBase64(masterKey);
        const key = await unwrapReverseShareKey(wrappedKey, master);
        const encoded = await exportKeyToBase64(key);
        if (!cancelled && getUserKey() === masterKey)
          setOpened({ teamId, masterKey, wrappedKey, key: encoded });
      } catch {
        // Keep placeholders when this device no longer holds the correct key.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, teamId, masterKey, wrappedKey]);
  return active &&
    opened?.teamId === teamId &&
    opened.masterKey === masterKey &&
    opened.wrappedKey === wrappedKey
    ? opened.key
    : null;
}
