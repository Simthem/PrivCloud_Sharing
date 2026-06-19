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
} from "@mantine/core";
import { createStyles } from "@mantine/emotion";
import { useForm } from "@mantine/form";
import { yupResolver } from "mantine-form-yup-resolver";
import Link from "next/link";
import { useRouter } from "next/router";
import { useRef, useState } from "react";
import { TbArrowLeft } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import * as yup from "yup";
import AltchaCaptcha from "../../../components/captcha/AltchaCaptcha";
import type { AltchaWidgetHandle } from "../../../components/captcha/AltchaWidget";
import { useAltchaSettings } from "../../../hooks/altcha.hook";
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
  const altcha = useAltchaSettings();
  const router = useRouter();
  const t = useTranslate();

  const captchaEnabled = altcha.enabled;
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();
  const captchaRef = useRef<AltchaWidgetHandle>(null);

  const resetCaptcha = () => {
    setCaptchaToken(undefined);
    captchaRef.current?.reset();
  };
  const handleCaptchaExpire = () => setCaptchaToken(undefined);
  const handleCaptchaError = resetCaptcha;

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
          onSubmit={form.onSubmit(async (values) => {
            const token = await resolveCaptchaToken();
            if (captchaEnabled && !token) return;

            await authService
              .requestResetPassword(values.email, token)
              .then(() => {
                toast.success(t("resetPassword.notify.success"));
                router.push("/auth/signIn");
              })
              .catch((error) => {
                resetCaptcha();
                toast.axiosError(error);
              });
          })}
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
            <Button
              type="submit"
              className={classes.control}
              disabled={
                captchaEnabled && altcha.shouldWaitForToken && !captchaToken
              }
            >
              <FormattedMessage id="resetPassword.text.resetPassword" />
            </Button>
          </Group>
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

export default ResetPassword;
