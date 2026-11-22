import { useRouter } from "next/router";
import { useEffect, useState } from "react";

// Path segment of links whose secret travels in the fragment instead.
export const SECRET_IN_FRAGMENT = "link";

/**
 * A bearer secret read from the URL fragment, which no server or proxy log
 * ever receives, then removed from the address bar and history. Links sent
 * before carried it in the path, as the `param` route segment.
 */
export default function useUrlSecret(param: string) {
  const router = useRouter();
  const [fromFragment, setFromFragment] = useState<string>();

  useEffect(() => {
    const value = window.location.hash.slice(1);
    if (!value) return;
    setFromFragment(decodeURIComponent(value));
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
  }, []);

  const fromPath = router.query[param];
  return (
    fromFragment ??
    (typeof fromPath === "string" && fromPath !== SECRET_IN_FRAGMENT
      ? fromPath
      : undefined)
  );
}
