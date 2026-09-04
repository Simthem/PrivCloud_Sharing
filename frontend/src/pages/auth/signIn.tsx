import { LoadingOverlay } from "@mantine/core";
import { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import SignInForm from "../../components/auth/SignInForm";
import Meta from "../../components/Meta";
import useUser from "../../hooks/user.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import {
  resolvePostAuthRedirectPath,
  safeRedirectPath,
} from "../../utils/router.util";
import { rememberPostAuthRedirectTarget } from "../../utils/authRedirect.util";

export function getServerSideProps(context: GetServerSidePropsContext) {
  return {
    props: {
      hasSession: Boolean(context.req.cookies.logged_in),
      redirectPath: context.query.redirect ?? null,
    },
  };
}

const SignIn = ({
  hasSession,
  redirectPath,
}: {
  hasSession?: boolean;
  redirectPath?: string;
}) => {
  const { refreshUser } = useUser();
  const router = useRouter();
  const t = useTranslate();
  const safePath =
    typeof redirectPath === "string"
      ? safeRedirectPath(redirectPath)
      : undefined;

  const [isLoading, setIsLoading] = useState(
    Boolean(hasSession && redirectPath),
  );

  // Keep the validated target per-tab for OAuth/TOTP. Browsers retain the
  // original fragment across an HTTP redirect when Location has no fragment,
  // so a Team E2E key can stay client-only instead of entering the query string.
  useEffect(() => {
    if (!safePath) return;
    rememberPostAuthRedirectTarget(`${safePath}${window.location.hash}`, {
      preserveExistingFragmentForSamePath: true,
    });
  }, [safePath]);

  // If the access token is expired, the middleware redirects to this page.
  // If the refresh token is still valid, the user will be redirected to the last page.
  useEffect(() => {
    if (!hasSession) {
      setIsLoading(false);
      return;
    }

    refreshUser()
      .then((user) => {
        if (user) {
          resolvePostAuthRedirectPath(safePath, user).then((target) =>
            router.replace(target),
          );
        } else {
          setIsLoading(false);
        }
      })
      .catch(() => setIsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isLoading)
    return <LoadingOverlay overlayProps={{ backgroundOpacity: 1 }} visible />;

  return (
    <>
      <Meta title={t("signin.title")} noIndex />
      <SignInForm redirectPath={safePath} />
    </>
  );
};
export default SignIn;
