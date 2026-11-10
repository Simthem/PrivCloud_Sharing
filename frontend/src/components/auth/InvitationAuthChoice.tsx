import {
  Alert,
  Anchor,
  Box,
  Button,
  Center,
  Loader,
  Stack,
  Text,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/router";
import { useEffect } from "react";
import useConfig from "../../hooks/config.hook";
import useOAuthProviders from "../../hooks/oauthProviders.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import {
  buildSignInRedirectPath,
  buildSignUpRedirectPath,
  rememberPostAuthRedirectTarget,
} from "../../utils/authRedirect.util";
import { rememberInvitedSignUpEmail } from "../../utils/emailVerification.util";
import OAuthProviders from "./OAuthProviders";

/**
 * Shown on an invitation page to a signed-out visitor: create the account the
 * invitation was sent to, or sign in when it already exists. The way back,
 * including a Team key fragment, stays in this tab and never enters a URL.
 */
export default function InvitationAuthChoice({
  queryKey,
  loadAccount,
}: {
  queryKey: string;
  loadAccount: () => Promise<{ email: string; accountExists: boolean }>;
}) {
  const t = useTranslate();
  const router = useRouter();
  const config = useConfig();
  const account = useQuery({
    queryKey: ["invitation-account", queryKey],
    queryFn: loadAccount,
    retry: false,
  });

  const oauthProviders = useOAuthProviders(
    !!account.data &&
      (account.data.accountExists ||
        config.getBoolean("oauth.allowRegistration")),
  );

  const rememberInvitation = () => {
    const here = router.asPath.split("#", 1)[0];
    rememberPostAuthRedirectTarget(`${here}${window.location.hash}`);
    return here;
  };

  // A provider button leaves the app without going through go().
  useEffect(() => {
    if (account.data) rememberInvitation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.data]);

  const go = (signUp: boolean) => {
    const here = rememberInvitation();
    if (signUp && account.data) rememberInvitedSignUpEmail(account.data.email);
    void router.push(
      signUp ? buildSignUpRedirectPath(here) : buildSignInRedirectPath(here),
    );
  };

  if (account.isLoading)
    return (
      <Center>
        <Loader size="sm" />
      </Center>
    );
  if (account.isError || !account.data)
    return <Alert color="red">{t("invitation.auth.invalid")}</Alert>;

  return (
    <Stack align="center" gap="sm" w="100%">
      <Text ta="center" size="sm">
        {t(
          account.data.accountExists
            ? "invitation.auth.signInHint"
            : "invitation.auth.signUpHint",
          { email: account.data.email },
        )}
      </Text>
      <Button onClick={() => go(!account.data!.accountExists)}>
        {t(
          account.data.accountExists
            ? "invitation.auth.signIn"
            : "invitation.auth.signUp",
        )}
      </Button>
      {!account.data.accountExists && (
        <Anchor
          component="button"
          type="button"
          size="sm"
          onClick={() => go(false)}
        >
          {t("invitation.auth.haveAccount")}
        </Anchor>
      )}
      <Box w="100%">
        <OAuthProviders providers={oauthProviders} />
      </Box>
    </Stack>
  );
}
