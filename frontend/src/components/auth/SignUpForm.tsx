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
  useMantineTheme,
} from "@mantine/core";
import { useForm, yupResolver } from "@mantine/form";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import Link from "next/link";
import { useRouter } from "next/router";
import { useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import * as yup from "yup";
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
  const theme = useMantineTheme();

  const captchaEnabled = config.get("hcaptcha.enabled");
  const captchaSiteKey = config.get("hcaptcha.siteKey");
  const captchaRef = useRef<HCaptcha>(null);
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const handleCaptchaExpire = () => setCaptchaToken(undefined);

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

  const signUp = async (email: string, username: string, password: string) => {
    setIsLoading(true);
    await authService
      .signUp(email.trim(), username.trim(), password.trim(), captchaToken)
      .then(async () => {
        const user = await refreshUser();
        if (user?.isAdmin) {
          router.replace("/admin/intro");
        } else {
          router.replace("/account");
        }
      })
      .catch(toast.axiosError)
      .finally(() => setIsLoading(false));
  };

  return (
    <Container size={420} my={40}>
      <Title order={2} align="center" weight={900}>
        <FormattedMessage id="signup.title" />
      </Title>
      {config.get("share.allowRegistration") && (
        <Text color="dimmed" size="sm" align="center" mt={5}>
          <FormattedMessage id="signup.description" />{" "}
          <Anchor component={Link} href={"signIn"} size="sm">
            <FormattedMessage id="signup.button.signin" />
          </Anchor>
        </Text>
      )}
      <Paper withBorder shadow="md" p={30} mt={30} radius="md">
        <form
          onSubmit={form.onSubmit((values) =>
            signUp(values.email, values.username, values.password),
          )}
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
          <Button fullWidth mt="xl" type="submit" loading={isLoading} disabled={captchaEnabled && !captchaToken}>
            <FormattedMessage id="signup.button.submit" />
          </Button>
          {captchaEnabled && captchaSiteKey && (
            <Group position="center" mt="md">
              <HCaptcha
                sitekey={captchaSiteKey}
                onVerify={setCaptchaToken}
                onExpire={handleCaptchaExpire}
                ref={captchaRef}
                theme={theme.colorScheme}
              />
            </Group>
          )}
        </form>
      </Paper>
    </Container>
  );
};

export default SignUpForm;
