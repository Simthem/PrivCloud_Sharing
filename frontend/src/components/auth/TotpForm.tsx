import {
  Anchor,
  Button,
  Container,
  Group,
  Paper,
  PinInput,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm, yupResolver } from "@mantine/form";
import { useRouter } from "next/router";
import { useState } from "react";
import { FormattedMessage } from "react-intl";
import * as yup from "yup";
import useTranslate from "../../hooks/useTranslate.hook";
import useUser from "../../hooks/user.hook";
import authService from "../../services/auth.service";
import { resolvePostAuthRedirectPath } from "../../utils/router.util";
import toast from "../../utils/toast.util";

function TotpForm({ redirectPath }: { redirectPath: string }) {
  const t = useTranslate();
  const router = useRouter();
  const { refreshUser } = useUser();

  const [loading, setLoading] = useState(false);
  const [useBackupCode, setUseBackupCode] = useState(false);

  const totpSchema = yup.object().shape({
    code: yup
      .string()
      .min(6, t("common.error.too-short", { length: 6 }))
      .required(t("common.error.field-required")),
  });

  const backupSchema = yup.object().shape({
    code: yup
      .string()
      .min(8, t("common.error.too-short", { length: 8 }))
      .max(8)
      .required(t("common.error.field-required")),
  });

  const form = useForm({
    initialValues: {
      code: "",
    },
    validate: yupResolver(useBackupCode ? backupSchema : totpSchema),
  });

  const onSubmit = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await authService.signInTotp(
        form.values.code,
        router.query.loginToken as string,
      );
      const user = await refreshUser({ refresh: false });
      const target = await resolvePostAuthRedirectPath(redirectPath, user);
      await router.replace(target);
    } catch (e) {
      toast.axiosError(e);
      form.setFieldError("code", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container size={420} my={40}>
      <Title order={2} ta="center" fw={900}>
        <FormattedMessage id="totp.title" />
      </Title>
      <Paper withBorder shadow="md" p={30} mt={30} radius="md">
        <form onSubmit={form.onSubmit(onSubmit)}>
          <Group justify="center">
            {useBackupCode ? (
              <TextInput
                label={t("totp.backup.label")}
                placeholder="A1B2C3D4"
                autoFocus
                style={{ width: "100%" }}
                {...form.getInputProps("code")}
              />
            ) : (
              <PinInput
                length={6}
                oneTimeCode
                aria-label="One time code"
                autoFocus={true}
                onComplete={onSubmit}
                {...form.getInputProps("code")}
              />
            )}
            <Button mt="md" type="submit" loading={loading}>
              {t("totp.button.signIn")}
            </Button>
          </Group>
          <Group justify="center" mt="md">
            <Anchor
              size="sm"
              onClick={() => {
                setUseBackupCode(!useBackupCode);
                form.reset();
              }}
            >
              {useBackupCode ? (
                <FormattedMessage id="totp.backup.useTotp" />
              ) : (
                <FormattedMessage id="totp.backup.useBackup" />
              )}
            </Anchor>
          </Group>
        </form>
      </Paper>
    </Container>
  );
}

export default TotpForm;
