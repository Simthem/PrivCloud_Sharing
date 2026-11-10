import {
  Anchor,
  Button,
  Container,
  Group,
  Loader,
  Paper,
  PasswordInput,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm, yupResolver } from "@mantine/form";
import { showNotification } from "@mantine/notifications";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import passkeyService from "../../services/passkey.service";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useRef, useState } from "react";
import { TbFingerprint, TbInfoCircle } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import * as yup from "yup";
import type { AltchaWidgetHandle } from "../captcha/AltchaWidget";
import { useAltchaSettings } from "../../hooks/altcha.hook";
import useConfig from "../../hooks/config.hook";
import useUser from "../../hooks/user.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import authService from "../../services/auth.service";
import OAuthProviders from "./OAuthProviders";
import { resolvePostAuthRedirectPath } from "../../utils/router.util";
import { markOAuthSignIn } from "../../utils/authRedirect.util";
import toast from "../../utils/toast.util";
import {
  isEmailVerificationRequiredError,
  rememberEmailVerificationEmail,
} from "../../utils/emailVerification.util";

const AltchaCaptcha = dynamic(() => import("../captcha/AltchaCaptcha"), {
  ssr: false,
});

const getOAuthUrl = (appUrl: string, provider: string) => {
  return `${appUrl}/api/oauth/auth/${provider}`;
};

const SignInForm = ({ redirectPath }: { redirectPath?: string }) => {
  const config = useConfig();
  const router = useRouter();
  const t = useTranslate();
  const { refreshUser } = useUser();
  const altcha = useAltchaSettings();

  const [oauthProviders, setOauthProviders] = useState<string[] | null>(null);
  const [isRedirectingToOauthProvider, setIsRedirectingToOauthProvider] =
    useState(false);

  const captchaEnabled = altcha.enabled;
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();
  const captchaRef = useRef<AltchaWidgetHandle>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const retryActive = retryAfterSeconds > 0;
  // Known after mount only: the server render has no WebAuthn.
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [isPasskeyLoading, setIsPasskeyLoading] = useState(false);

  useEffect(() => {
    setPasskeySupported(browserSupportsWebAuthn());
  }, []);

  useEffect(() => {
    if (!retryActive) return;
    const timer = window.setInterval(
      () => setRetryAfterSeconds((seconds) => Math.max(0, seconds - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [retryActive]);

  useEffect(() => {
    if (!router.isReady || router.query.error !== "session-expired") return;
    showNotification({
      id: "auth-session-expired",
      icon: <TbInfoCircle />,
      color: "blue",
      radius: "md",
      title: t("signIn.notify.session-expired.title"),
      message: t("signIn.notify.session-expired.description"),
    });
  }, [router.isReady, router.query.error, t]);

  const resetCaptcha = () => {
    setCaptchaToken(undefined);
    captchaRef.current?.reset();
  };
  const handleCaptchaExpire = () => setCaptchaToken(undefined);
  const handleCaptchaError = resetCaptcha;

  const validationSchema = yup.object().shape({
    emailOrUsername: yup.string().required(t("common.error.field-required")),
    password: yup.string().required(t("common.error.field-required")),
  });

  const form = useForm({
    initialValues: {
      emailOrUsername: "",
      password: "",
    },
    validate: yupResolver(validationSchema),
  });

  const resolveCaptchaToken = async () => {
    if (!captchaEnabled) return undefined;
    if (captchaToken) return captchaToken;

    const result = await captchaRef.current?.verify();
    if (result?.payload) {
      setCaptchaToken(result.payload);
      return result.payload;
    }

    return undefined;
  };

  const signIn = async (
    email: string,
    password: string,
    captchaPayload?: string,
  ) => {
    if (retryAfterSeconds > 0) return;
    setIsLoading(true);
    await authService
      .signIn(email.trim(), password, captchaPayload)
      .then(async (response) => {
        if (response.data["loginToken"]) {
          // Prompt the user to enter their totp code
          showNotification({
            icon: <TbInfoCircle />,
            color: "blue",
            radius: "md",
            title: t("signIn.notify.totp-required.title"),
            message: t("signIn.notify.totp-required.description"),
          });
          router.push(
            `/auth/totp/${
              response.data["loginToken"]
            }?redirect=${encodeURIComponent(redirectPath ?? "")}`,
          );
        } else {
          const user = await refreshUser({ refresh: false });
          const target = await resolvePostAuthRedirectPath(redirectPath, user);
          router.replace(target);
        }
      })
      .catch((error) => {
        resetCaptcha();
        const retry = Number(error?.response?.data?.retryAfterSeconds);
        if (error?.response?.status === 429 && Number.isFinite(retry)) {
          setRetryAfterSeconds(Math.max(1, Math.ceil(retry)));
          toast.error(
            t("signIn.notify.rate-limited", {
              seconds: Math.max(1, Math.ceil(retry)),
            }),
          );
          return;
        }
        if (isEmailVerificationRequiredError(error)) {
          rememberEmailVerificationEmail(email);
          router.push("/auth/verify-email");
          return;
        }
        toast.error(t("signIn.notify.error"));
      })
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    authService
      .getAvailableOAuth()
      .then((providers) => {
        setOauthProviders(providers.data);
        if (
          providers.data.length === 1 &&
          config.getBoolean("oauth.disablePassword")
        ) {
          setIsRedirectingToOauthProvider(true);
          router.push(getOAuthUrl(window.location.origin, providers.data[0]));
        }
      })
      .catch(toast.axiosError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signInWithPasskey = async () => {
    setIsPasskeyLoading(true);
    try {
      await passkeyService.signIn();
      const user = await refreshUser({ refresh: false });
      router.replace(await resolvePostAuthRedirectPath(redirectPath, user));
    } catch (error) {
      // Closing the browser prompt is a choice, not an error.
      if ((error as Error)?.name === "NotAllowedError") return;
      if (isEmailVerificationRequiredError(error)) {
        router.push("/auth/verify-email");
        return;
      }
      toast.error(t("signIn.notify.passkey-error"));
    } finally {
      setIsPasskeyLoading(false);
    }
  };

  useEffect(() => {
    const loadProviders = () => {
      authService
        .getAvailableOAuth()
        .then((providers) => {
          setOauthProviders(providers.data);
          if (
            providers.data.length === 1 &&
            config.getBoolean("oauth.disablePassword")
          ) {
            setIsRedirectingToOauthProvider(true);
            markOAuthSignIn();
            router.push(getOAuthUrl(window.location.origin, providers.data[0]));
          }
        })
        .catch(() => setOauthProviders([]));
    };

    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(loadProviders, {
        timeout: 1500,
      });
      return () => window.cancelIdleCallback(idleId);
    }

    const timeout = globalThis.setTimeout(loadProviders, 300);
    return () => globalThis.clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const oauthDisabledPassword = config.getBoolean("oauth.disablePassword");

  if (oauthDisabledPassword && !oauthProviders) {
    return (
      <Group align="center" justify="center">
        <Loader size="sm" />
        <Text ta="center">
          <FormattedMessage id="common.text.redirecting" />
        </Text>
      </Group>
    );
  }

  if (isRedirectingToOauthProvider)
    return (
      <Group align="center" justify="center">
        <Loader size="sm" />
        <Text ta="center">
          <FormattedMessage id="common.text.redirecting" />
        </Text>
      </Group>
    );

  return (
    <Container size={420} my={40}>
      {/* h1 is required by Bing webmaster guidelines (one h1 per page). */}
      <Title order={1} ta="center" fw={900} fz={{ base: 26, sm: 30 }}>
        <FormattedMessage id="signin.title" />
      </Title>
      {config.getBoolean("share.allowRegistration") && (
        <Text c="dimmed" size="sm" ta="center" mt={5}>
          <FormattedMessage id="signin.description" />{" "}
          <Anchor component={Link} href={"signUp"} size="sm">
            <FormattedMessage id="signin.button.signup" />
          </Anchor>
        </Text>
      )}
      <Paper withBorder shadow="md" p={30} mt={30} radius="md">
        {config.getBoolean("oauth.disablePassword") || (
          <form
            onSubmit={form.onSubmit(async (values) => {
              const token = await resolveCaptchaToken();
              if (captchaEnabled && !token) return;

              await signIn(values.emailOrUsername, values.password, token);
            })}
          >
            <TextInput
              label={t("signin.input.email-or-username")}
              placeholder={t("signin.input.email-or-username.placeholder")}
              {...form.getInputProps("emailOrUsername")}
            />
            <PasswordInput
              label={t("signin.input.password")}
              placeholder={t("signin.input.password.placeholder")}
              mt="md"
              {...form.getInputProps("password")}
            />
            {config.getBoolean("smtp.enabled") && (
              <Group justify="right" mt="xs">
                <Anchor component={Link} href="/auth/resetPassword" size="xs">
                  <FormattedMessage id="resetPassword.title" />
                </Anchor>
              </Group>
            )}
            <Button
              fullWidth
              mt="xl"
              type="submit"
              loading={isLoading}
              disabled={
                retryAfterSeconds > 0 ||
                (captchaEnabled && altcha.shouldWaitForToken && !captchaToken)
              }
            >
              {retryAfterSeconds > 0
                ? t("signin.button.retry-after", {
                    seconds: retryAfterSeconds,
                  })
                : t("signin.button.submit")}
            </Button>
            {captchaEnabled && (
              <Group justify="center" mt="md">
                <AltchaCaptcha
                  onVerify={setCaptchaToken}
                  onExpire={handleCaptchaExpire}
                  onError={handleCaptchaError}
                  widgetRef={captchaRef}
                />
              </Group>
            )}
          </form>
        )}
        {passkeySupported && (
          <Button
            fullWidth
            mt="sm"
            variant="default"
            leftSection={<TbFingerprint size={16} />}
            loading={isPasskeyLoading}
            onClick={signInWithPasskey}
          >
            {t("signin.button.passkey")}
          </Button>
        )}
        {oauthProviders && (
          <OAuthProviders
            providers={oauthProviders}
            onlyMethod={oauthDisabledPassword}
          />
        )}
      </Paper>
    </Container>
  );
};

export default SignInForm;
