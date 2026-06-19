import {
  Anchor,
  Button,
  Container,
  Group,
  Paper,
  PasswordInput,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm, yupResolver } from "@mantine/form";
import Link from "next/link";
import { useRouter } from "next/router";
import { useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import * as yup from "yup";
import AltchaCaptcha from "../captcha/AltchaCaptcha";
import type { AltchaWidgetHandle } from "../captcha/AltchaWidget";
import { useAltchaSettings } from "../../hooks/altcha.hook";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import useUser from "../../hooks/user.hook";
import authService from "../../services/auth.service";
import toast from "../../utils/toast.util";

const SignUpForm = () => {
  const config = useConfig();
  const router = useRouter();
  const t = useTranslate();
  const { refreshUser } = useUser();
  const altcha = useAltchaSettings();

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
    email: yup.string().email(t("common.error.invalid-email")).required(),
    username: yup
      .string()
      .min(3, t("common.error.too-short", { length: 3 }))
      .required(t("common.error.field-required")),
    password: yup
      .string()
      .min(8, t("common.error.too-short", { length: 8 }))
      .required(t("common.error.field-required")),
  });

  const form = useForm({
    initialValues: {
      email: "",
      username: "",
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

  const signUp = async (
    email: string,
    username: string,
    password: string,
    captchaPayload?: string,
  ) => {
    setIsLoading(true);
    await authService
      .signUp(email.trim(), username.trim(), password, captchaPayload)
      .then(async () => {
        const user = await refreshUser();
        if (user?.isAdmin) {
          router.replace("/admin/intro");
        } else {
          router.replace("/account");
        }
      })
      .catch((error) => {
        resetCaptcha();
        toast.axiosError(error);
      })
      .finally(() => setIsLoading(false));
  };

  return (
    <Container size={420} my={40}>
      {/* h1 is required by Bing webmaster guidelines (one h1 per page). */}
      <Title order={1} ta="center" fw={900} fz={{ base: 26, sm: 30 }}>
        <FormattedMessage id="signup.title" />
      </Title>
      {config.get("share.allowRegistration") && (
        <Text c="dimmed" size="sm" ta="center" mt={5}>
          <FormattedMessage id="signup.description" />{" "}
          <Anchor component={Link} href={"signIn"} size="sm">
            <FormattedMessage id="signup.button.signin" />
          </Anchor>
        </Text>
      )}
      <Paper withBorder shadow="md" p={30} mt={30} radius="md">
        <form
          onSubmit={form.onSubmit(async (values) => {
            const token = await resolveCaptchaToken();
            if (captchaEnabled && !token) return;

            await signUp(values.email, values.username, values.password, token);
          })}
        >
          <TextInput
            label={t("signup.input.username")}
            placeholder={t("signup.input.username.placeholder")}
            {...form.getInputProps("username")}
          />
          <TextInput
            label={t("signup.input.email")}
            placeholder={t("signup.input.email.placeholder")}
            mt="md"
            {...form.getInputProps("email")}
          />
          <PasswordInput
            label={t("signin.input.password")}
            placeholder={t("signin.input.password.placeholder")}
            mt="md"
            {...form.getInputProps("password")}
          />
          <Button
            fullWidth
            mt="xl"
            type="submit"
            loading={isLoading}
            disabled={
              captchaEnabled && altcha.shouldWaitForToken && !captchaToken
            }
          >
            <FormattedMessage id="signup.button.submit" />
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
      </Paper>
    </Container>
  );
};

export default SignUpForm;
