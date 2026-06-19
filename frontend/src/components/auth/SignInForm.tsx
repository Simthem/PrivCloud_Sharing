import {
  Anchor,
  Button,
  Container,
  Group,
  Loader,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { createStyles } from "@mantine/emotion";
import { useForm, yupResolver } from "@mantine/form";
import { showNotification } from "@mantine/notifications";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useRef, useState } from "react";
import { TbInfoCircle } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import * as yup from "yup";
import AltchaCaptcha from "../captcha/AltchaCaptcha";
import type { AltchaWidgetHandle } from "../captcha/AltchaWidget";
import { useAltchaSettings } from "../../hooks/altcha.hook";
import useConfig from "../../hooks/config.hook";
import useUser from "../../hooks/user.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import authService from "../../services/auth.service";
import {
  getOAuthIcon,
  getOAuthUrl,
  getOAuthColor,
} from "../../utils/oauth.util";
import { resolvePostAuthRedirectPath } from "../../utils/router.util";
import toast from "../../utils/toast.util";

const useStyles = createStyles((theme) => ({
  signInWith: {
    fontWeight: 500,
    "&:before": {
      content: "''",
      flex: 1,
      display: "block",
    },
    "&:after": {
      content: "''",
      flex: 1,
      display: "block",
    },
  },
  or: {
    "&:before": {
      content: "''",
      flex: 1,
      display: "block",
      borderTopWidth: 1,
      borderTopStyle: "solid",
      borderColor:
        theme.other.colorScheme === "dark"
          ? theme.colors.dark[3]
          : theme.colors.gray[4],
    },
    "&:after": {
      content: "''",
      flex: 1,
      display: "block",
      borderTopWidth: 1,
      borderTopStyle: "solid",
      borderColor:
        theme.other.colorScheme === "dark"
          ? theme.colors.dark[3]
          : theme.colors.gray[4],
    },
  },
}));

const SignInForm = ({ redirectPath }: { redirectPath?: string }) => {
  const config = useConfig();
  const router = useRouter();
  const t = useTranslate();
  const { refreshUser } = useUser();
  const { classes } = useStyles();
  const altcha = useAltchaSettings();

  const [oauthProviders, setOauthProviders] = useState<string[] | null>(null);
  const [isRedirectingToOauthProvider, setIsRedirectingToOauthProvider] =
    useState(false);

  const captchaEnabled = altcha.enabled;
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();
  const captchaRef = useRef<AltchaWidgetHandle>(null);
  const [isLoading, setIsLoading] = useState(false);

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
          const target = await resolvePostAuthRedirectPath(
            redirectPath,
            user,
          );
          router.replace(target);
        }
      })
      .catch(() => {
        resetCaptcha();
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
          config.get("oauth.disablePassword")
        ) {
          setIsRedirectingToOauthProvider(true);
          router.push(getOAuthUrl(window.location.origin, providers.data[0]));
        }
      })
      .catch(toast.axiosError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!oauthProviders) return null;

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
      {config.get("share.allowRegistration") && (
        <Text c="dimmed" size="sm" ta="center" mt={5}>
          <FormattedMessage id="signin.description" />{" "}
          <Anchor component={Link} href={"signUp"} size="sm">
            <FormattedMessage id="signin.button.signup" />
          </Anchor>
        </Text>
      )}
      <Paper withBorder shadow="md" p={30} mt={30} radius="md">
        {config.get("oauth.disablePassword") || (
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
            {config.get("smtp.enabled") && (
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
                captchaEnabled && altcha.shouldWaitForToken && !captchaToken
              }
            >
              <FormattedMessage id="signin.button.submit" />
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
        {oauthProviders.length > 0 && (
          <Stack mt={config.get("oauth.disablePassword") ? undefined : "xl"}>
            {config.get("oauth.disablePassword") ? (
              <Group align="center" className={classes.signInWith}>
                <Text>{t("signIn.oauth.signInWith")}</Text>
              </Group>
            ) : (
              <Group align="center" className={classes.or}>
                <Text>{t("signIn.oauth.or")}</Text>
              </Group>
            )}
            <Group justify="center">
              {oauthProviders.map((provider) => (
                <Button
                  key={provider}
                  component="a"
                  title={t(`signIn.oauth.${provider}`)}
                  href={getOAuthUrl(window.location.origin, provider)}
                  variant="outline"
                  color={getOAuthColor(provider)}
                  fullWidth
                >
                  {getOAuthIcon(provider)}
                  {"\u2002" + t(`signIn.oauth.${provider}`)}
                </Button>
              ))}
            </Group>
          </Stack>
        )}
      </Paper>
    </Container>
  );
};

export default SignInForm;
