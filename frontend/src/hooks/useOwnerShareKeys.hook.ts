import { useCallback, useEffect, useState } from "react";
import { MyShare } from "../types/share.type";
import { getUserKey } from "../utils/crypto.util";
import { reportShareCryptoEvent } from "../utils/shareCryptoEvents.util";
import {
  LEGACY_ACCOUNT_KEY,
  SHARE_DEK_V1,
  resolveOwnerShareKey,
  resolveShareCryptoScheme,
} from "../utils/shareKey.util";

/**
 * Key an owner puts in the recipient link of each of their shares.
 *
 * Legacy shares use K_master, read at call time as before. SHARE_DEK_V1
 * shares need their own K_share: it is unwrapped here once per list, so that
 * copy and QR buttons stay synchronous and keep the clipboard user gesture.
 */
export default function useOwnerShareKeys(shares: MyShare[] | undefined) {
  const [masterKey, setMasterKey] = useState<string | null>(null);
  const [shareKeys, setShareKeys] = useState<Record<string, string>>({});

  useEffect(() => {
    const sync = () => setMasterKey(getUserKey());
    sync();
    window.addEventListener("e2e-key-stored", sync);
    window.addEventListener("e2e-key-removed", sync);
    return () => {
      window.removeEventListener("e2e-key-stored", sync);
      window.removeEventListener("e2e-key-removed", sync);
    };
  }, []);

  useEffect(() => {
    const dekShares = (shares ?? []).filter(
      (share) =>
        share.isE2EEncrypted &&
        share.cryptoScheme === SHARE_DEK_V1 &&
        !!share.wrappedShareKey,
    );
    if (!masterKey || dekShares.length === 0) {
      setShareKeys({});
      return;
    }

    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        dekShares.map(async (share) => {
          try {
            return [
              share.id,
              await resolveOwnerShareKey(share.id, masterKey, share),
            ] as const;
          } catch {
            reportShareCryptoEvent("unwrap_error", SHARE_DEK_V1);
            return null;
          }
        }),
      );
      if (cancelled) return;
      setShareKeys(
        Object.fromEntries(
          entries.filter((entry): entry is readonly [string, string] =>
            Boolean(entry),
          ),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [shares, masterKey]);

  return useCallback(
    (share: MyShare): string | null => {
      if (!share.isE2EEncrypted || share.teamFolderId) return null;
      let scheme: number;
      try {
        scheme = resolveShareCryptoScheme(share.cryptoScheme);
      } catch {
        return null;
      }
      if (scheme === LEGACY_ACCOUNT_KEY) return getUserKey();
      return shareKeys[share.id] ?? null;
    },
    [shareKeys],
  );
}
