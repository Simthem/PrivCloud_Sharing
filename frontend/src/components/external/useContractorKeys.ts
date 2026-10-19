import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getUserKey, importKeyFromBase64 } from "../../utils/crypto.util";
import { loadContractorPrivateKeys } from "../../utils/externalPreviewCrypto.util";

/** Private keys of the signed-in contractor, once their E2E key is unlocked. */
export default function useContractorKeys() {
  // sessionStorage only exists in the browser: reading it during render would
  // make the server HTML differ from the first client render.
  const [encoded, setEncoded] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const read = () => {
      setEncoded(getUserKey());
      setChecked(true);
    };
    read();
    window.addEventListener("e2e-key-stored", read);
    return () => window.removeEventListener("e2e-key-stored", read);
  }, []);

  const query = useQuery({
    queryKey: ["external-contractor-keys", encoded ? "unlocked" : "locked"],
    queryFn: async () =>
      loadContractorPrivateKeys(await importKeyFromBase64(encoded!)),
    enabled: !!encoded,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: false,
  });
  return { ...query, locked: checked && !encoded };
}
