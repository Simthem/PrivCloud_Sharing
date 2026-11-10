import { useRouter } from "next/router";
import { useEffect } from "react";
import useUser from "../../hooks/user.hook";
import { takeOAuthSignInMark } from "../../utils/authRedirect.util";
import { resolvePostAuthRedirectPath } from "../../utils/router.util";

const OAUTH_LANDING_PAGES = ["/", "/upload"];

/** Finishes a provider sign-in, which always comes back to the app root. */
const OAuthReturn = () => {
  const router = useRouter();
  const { user } = useUser();

  useEffect(() => {
    if (!user || !router.isReady || !takeOAuthSignInMark()) return;
    if (!OAUTH_LANDING_PAGES.includes(router.pathname)) return;
    void resolvePostAuthRedirectPath(undefined, user).then((target) => {
      if (target !== router.asPath) void router.replace(target);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, router.isReady]);

  return null;
};

export default OAuthReturn;
