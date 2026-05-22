import {
  Button,
  Center,
  Code,
  Group,
  Image,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { yupResolver } from "mantine-form-yup-resolver";
import { useModals } from "@mantine/modals";
import { useState } from "react";
import { FormattedMessage } from "react-intl";
import * as yup from "yup";
import useTranslate, {
  translateOutsideContext,
} from "../../hooks/useTranslate.hook";
import authService from "../../services/auth.service";
import toast from "../../utils/toast.util";

const showEnableTotpModal = (
  modals: ReturnType<typeof useModals>,
  refreshUser: () => {},
  options: {
    qrCode: string;
    secret: string;
    password: string;
  },
) => {
  const t = translateOutsideContext();
  return modals.openModal({
    title: t("account.modal.totp.title"),
    children: (
      <CreateEnableTotpModal options={options} refreshUser={refreshUser} />
    ),
  });
};

const CreateEnableTotpModal = ({
  options,
  refreshUser,
}: {
  options: {
    qrCode: string;
    secret: string;
    password: string;
  };
  refreshUser: () => {};
}) => {
  const modals = useModals();
  const t = useTranslate();
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  const validationSchema = yup.object().shape({
    code: yup
      .string()
      .min(6)
      .max(6)
      .required()
      .matches(/^[0-9]+$/, { message: "Code must be a number" }),
  });

  const form = useForm({
    initialValues: {
      code: "",
    },
    validate: yupResolver(validationSchema),
  });

  const downloadBackupCodes = (codes: string[]) => {
    const content =
      t("account.modal.totp.backup.fileHeader") +
      "\n" +
      "-".repeat(40) +
      "\n\n" +
      codes.map((c, i) => `${String(i + 1).padStart(2, " ")}. ${c}`).join("\n") +
      "\n\n" +
      t("account.modal.totp.backup.fileFooter");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  // -- Backup codes view (after TOTP verified) -----------------
  if (backupCodes) {
    return (
      <div>
        <Center>
          <Stack>
            <Text fw={700}>
              <FormattedMessage id="account.modal.totp.backup.title" />
            </Text>
            <Text size="sm" c="dimmed">
              <FormattedMessage id="account.modal.totp.backup.description" />
            </Text>
            <Code block>
              {backupCodes
                .map((c, i) => `${String(i + 1).padStart(2, " ")}. ${c}`)
                .join("\n")}
            </Code>
            <Group justify="center" mt="md">
              <Button
                variant="outline"
                onClick={() => downloadBackupCodes(backupCodes)}
              >
                <FormattedMessage id="account.modal.totp.backup.download" />
              </Button>
              <Button
                onClick={() => {
                  navigator.clipboard.writeText(backupCodes.join("\n"));
                  toast.success(t("common.notify.copied"));
                }}
                variant="outline"
              >
                <FormattedMessage id="common.button.clickToCopy" />
              </Button>
            </Group>
            <Button
              mt="md"
              onClick={() => {
                modals.closeAll();
                refreshUser();
              }}
            >
              <FormattedMessage id="account.modal.totp.backup.done" />
            </Button>
          </Stack>
        </Center>
      </div>
    );
  }

  // -- QR code + verification view -----------------------------
  return (
    <div>
      <Center>
        <Stack>
          <Text>
            <FormattedMessage id="account.modal.totp.step1" />
          </Text>
          <Image src={options.qrCode} alt="QR Code" />

          <Center>
            <span>
              {" "}
              <FormattedMessage id="common.text.or" />
            </span>
          </Center>

          <Tooltip label={t("common.button.clickToCopy")}>
            <Button
              onClick={() => {
                navigator.clipboard.writeText(options.secret);
                toast.success(t("common.notify.copied"));
              }}
            >
              {options.secret}
            </Button>
          </Tooltip>
          <Center>
            <Text fz="xs"></Text>
          </Center>

          <Text>
            <FormattedMessage id="account.modal.totp.step2" />
          </Text>

          <form
            onSubmit={form.onSubmit((values) => {
              authService
                .verifyTOTP(values.code, options.password)
                .then(({ backupCodes: codes }) => {
                  toast.success(t("account.notify.totp.enable"));
                  setBackupCodes(codes);
                })
                .catch(toast.axiosError);
            })}
          >
            <Group align="end">
              <TextInput
                style={{ flex: "1" }}
                variant="filled"
                label={t("account.modal.totp.code")}
                placeholder="******"
                {...form.getInputProps("code")}
              />

              <Button
                style={{ flex: "0 0 auto" }}
                variant="outline"
                type="submit"
              >
                <FormattedMessage id="account.modal.totp.verify" />
              </Button>
            </Group>
          </form>
        </Stack>
      </Center>
    </div>
  );
};

export default showEnableTotpModal;
