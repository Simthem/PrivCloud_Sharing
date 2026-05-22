import {
  Anchor,
  Box,
  Button,
  Center,
  Container,
  Group,
  Paper,
  Text,
  TextInput,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { createStyles } from "@mantine/emotion";
import { useForm } from "@mantine/form";
import { yupResolver } from "mantine-form-yup-resolver";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import Link from "next/link";
import { useRouter } from "next/router";
import { useRef, useState } from "react";
import { TbArrowLeft } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import * as yup from "yup";
import useConfig from "../../../hooks/config.hook";
import useTranslate from "../../../hooks/useTranslate.hook";
import authService from "../../../services/auth.service";
import toast from "../../../utils/toast.util";

const useStyles = createStyles((theme) => ({
  title: {
    fontSize: 26,
    fontWeight: 900,
    fontFamily: `Greycliff CF, ${theme.fontFamily}`,
  },

  controls: {
    [`@media (max-width: ${theme.breakpoints.xs})`]: {
      flexDirection: "column-reverse",
    },
  },

  control: {
    [`@media (max-width: ${theme.breakpoints.xs})`]: {
      width: "100%",
      textAlign: "center",
    },
  },
}));

const ResetPassword = () => {
  const { classes } = useStyles();
  const config = useConfig();
  const router = useRouter();
  const t = useTranslate();
  const theme = useMantineTheme();

  const captchaEnabled = config.get("hcaptcha.enabled");
  const captchaSiteKey = config.get("hcaptcha.siteKey");
  const captchaRef = useRef<HCaptcha>(null);
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();
  const handleCaptchaExpire = () => setCaptchaToken(undefined);
  const handleCaptchaError = (error: any) => {
    console.warn("[hCaptcha Error]", error);
    // Attempt to reset the captcha on error (e.g., WebGL context lost on Safari)
    if (captchaRef.current?.resetCaptcha) {
      captchaRef.current.resetCaptcha();
    }
  };

  const form = useForm({
    initialValues: {
      email: "",
    },
    validate: yupResolver(
      yup.object().shape({
        email: yup
          .string()
          .email(t("common.error.invalid-email"))
          .required(t("common.error.field-required")),
      }),
    ),
  });

  return (
    <Container size={460} my={30}>
      <Title order={2} fw={900} ta="center">
        <FormattedMessage id="resetPassword.title" />
      </Title>
      <Text c="dimmed" size="sm" ta="center">
        <FormattedMessage id="resetPassword.description" />
      </Text>

      <Paper withBorder shadow="md" p={30} radius="md" mt="xl">
        <form
          onSubmit={form.onSubmit((values) =>
            authService
              .requestResetPassword(values.email, captchaToken)
              .then(() => {
                toast.success(t("resetPassword.notify.success"));
                router.push("/auth/signIn");
              })
              .catch(toast.axiosError),
          )}
        >
          <TextInput
            label={t("signup.input.email")}
            placeholder={t("signup.input.email.placeholder")}
            {...form.getInputProps("email")}
          />
          <Group justify="space-between" mt="lg" className={classes.controls}>
            <Anchor
              component={Link}
              c="dimmed"
              size="sm"
              className={classes.control}
              href={"/auth/signIn"}
            >
              <Center inline>
                <TbArrowLeft size={12} />
                <Box ml={5}>
                  <FormattedMessage id="resetPassword.button.back" />
                </Box>
              </Center>
            </Anchor>
            <Button type="submit" className={classes.control} disabled={captchaEnabled && !captchaToken}>
              <FormattedMessage id="resetPassword.text.resetPassword" />
            </Button>
          </Group>
          {captchaEnabled && captchaSiteKey && (
            <Group justify="center" mt="md">
              <HCaptcha
                sitekey={captchaSiteKey}
                onVerify={setCaptchaToken}
                onExpire={handleCaptchaExpire}
                onError={handleCaptchaError}
                ref={captchaRef}
                theme={theme.other.colorScheme}
              />
            </Group>
          )}
        </form>
      </Paper>
    </Container>
  );
};

export default ResetPassword;
