import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  CopyButton,
  Divider,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMutation } from "@tanstack/react-query";
import { TbCheck, TbCopy, TbLink, TbMail, TbPlus, TbTrash } from "react-icons/tb";
import { useIntl } from "react-intl";
import signingService, {
  CreateSignatureRequestPayload,
  SignatureRecipient,
} from "../../services/signing.service";
import toast from "../../utils/toast.util";

interface FileOption {
  id: string;
  name: string;
}

interface Props {
  opened: boolean;
  onClose: () => void;
  shareId: string;
  files: FileOption[];
  encryptionKey?: string | null;
  teamId?: string;
}

interface RecipientEntry {
  name: string;
  email: string;
  role: "SIGNER" | "APPROVER" | "CC";
}

export default function RequestSignatureModal({
  opened,
  onClose,
  shareId,
  files,
  encryptionKey,
  teamId,
}: Props) {
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });

  const form = useForm({
    initialValues: {
      fileId: files.length === 1 ? files[0].id : "",
      message: "",
      signatureLevel: "AES" as "AES",
      addApprovalField: true,
      addApprovalMention: true,
      addInitials: false,
      sendE2EKeyByEmail: false,
      recipients: [{ name: "", email: "", role: "SIGNER" as const }] as RecipientEntry[],
    },
    validate: {
      fileId: (val: string) => (!val ? t("signing.modal.error.file-required") : null),
      recipients: {
        name: (val: string) => (!val ? t("signing.modal.error.name-required") : null),
        email: (val: string) =>
          !val || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)
            ? t("signing.modal.error.email-invalid")
            : null,
      },
    },
  });

  const [loading, setLoading] = useState(false);
  const [createdRecipients, setCreatedRecipients] = useState<SignatureRecipient[] | null>(null);
  const [emailDeliveryFailures, setEmailDeliveryFailures] = useState(0);

  const createMutation = useMutation({
    mutationFn: (data: CreateSignatureRequestPayload) =>
      signingService.createRequest(data),
    onSuccess: (result: any) => {
      toast.success(t("signing.modal.notify.success"));
      setLoading(false);
      setEmailDeliveryFailures(result?.emailDeliveryFailures || 0);
      // Show signing links returned by the backend.
      if (result?.recipients?.length) {
        setCreatedRecipients(result.recipients);
      } else {
        handleClose();
      }
    },
    onError: () => {
      toast.error(t("signing.modal.notify.error"));
      setLoading(false);
    },
  });

  const handleClose = () => {
    setCreatedRecipients(null);
    setEmailDeliveryFailures(0);
    form.reset();
    onClose();
  };

  const handleSubmit = (values: typeof form.values) => {
    if (values.recipients.length === 0) {
      toast.error(t("signing.modal.error.no-recipients"));
      return;
    }

    setLoading(true);

    // Auto-generate signature fields for each SIGNER
    const fields = values.recipients
      .filter((r) => r.role === "SIGNER")
      .map((r, idx) => ({
        assignedRecipientEmail: r.email,
        type: "SIGNATURE" as const,
        page: 1,
        posX: 50,
        posY: 650 - idx * 100,
        width: 200,
        height: 80,
        required: true,
      }));

    const shouldEmailE2EKey = Boolean(encryptionKey && values.sendE2EKeyByEmail);

    createMutation.mutate({
      shareId,
      fileId: values.fileId,
      message: values.message || undefined,
      signatureLevel: values.signatureLevel,
      addApprovalField: values.addApprovalField,
      addApprovalMention: values.addApprovalMention,
      addInitials: values.addInitials,
      isE2EEncrypted: !!encryptionKey,
      sendE2EKeyByEmail: shouldEmailE2EKey,
      e2eKey: shouldEmailE2EKey ? encryptionKey || undefined : undefined,
      teamId: teamId || undefined,
      recipients: values.recipients.map((r) => ({
        name: r.name,
        email: r.email,
        role: r.role,
      })),
      fields,
    });
  };

  const addRecipient = () => {
    form.insertListItem("recipients", {
      name: "",
      email: "",
      role: "SIGNER",
    });
  };

  const removeRecipient = (index: number) => {
    if (form.values.recipients.length > 1) {
      form.removeListItem("recipients", index);
    }
  };

  const fileOptions = files.map((f) => ({ value: f.id, label: f.name }));

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={createdRecipients ? "Liens de signature" : t("signing.modal.title")}
      size="lg"
    >
      {createdRecipients ? (
        <Stack gap="md">
          <Alert color={emailDeliveryFailures > 0 ? "yellow" : "green"} icon={<TbMail size={16} />}>
            {emailDeliveryFailures > 0
              ? "La demande de signature a été créée, mais certains emails n'ont pas pu être envoyés. Partagez les liens ci-dessous directement :"
              : "La demande de signature a été créée. Les invitations par email ont été envoyées. Vous pouvez aussi partager les liens ci-dessous directement :"}
          </Alert>
          {createdRecipients
            .filter((r) => r.signingToken && r.role !== "CC")
            .map((r) => {
              const keyFragment = encryptionKey ? `#key=${encryptionKey}` : "";
              const signingUrl = `${window.location.origin}/sign/${r.signingToken}${keyFragment}`;
              return (
                <Paper key={r.id} withBorder p="md">
                  <Group justify="space-between" mb="xs">
                    <div>
                      <Text size="md" fw={600}>{r.name}</Text>
                      <Text size="sm" c="dimmed">{r.email}</Text>
                    </div>
                    <Badge
                      color={r.role === "SIGNER" ? "blue" : "grape"}
                      variant="light"
                      size="md"
                    >
                      {r.role === "SIGNER" ? "Signataire" : "Approbateur"}
                    </Badge>
                  </Group>
                  <Group gap="xs" wrap="nowrap">
                    <TextInput
                      readOnly
                      size="sm"
                      value={signingUrl}
                      leftSection={<TbLink size={14} />}
                      style={{ flex: 1 }}
                    />
                    <CopyButton value={signingUrl}>
                      {({ copied, copy }) => (
                        <ActionIcon color={copied ? "green" : "blue"} variant="light" onClick={copy} size="lg">
                          {copied ? <TbCheck size={16} /> : <TbCopy size={16} />}
                        </ActionIcon>
                      )}
                    </CopyButton>
                  </Group>
                </Paper>
              );
            })}
          <Button onClick={handleClose} fullWidth variant="light">
            Terminé
          </Button>
        </Stack>
      ) : (
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          {/* File selection */}
          {files.length > 1 ? (
            <Select
              label={t("signing.modal.file")}
              placeholder={t("signing.modal.file-placeholder")}
              data={fileOptions}
              required
              {...form.getInputProps("fileId")}
            />
          ) : (
            <TextInput
              label={t("signing.modal.file")}
              value={files[0]?.name || ""}
              disabled
            />
          )}

          {/* Message */}
          <Textarea
            label={t("signing.modal.message")}
            placeholder={t("signing.modal.message-placeholder")}
            {...form.getInputProps("message")}
          />

          {/* Signature level */}
          <div>
            <Text size="sm" fw={500} mb={4}>
              {t("signing.modal.level")}
            </Text>
            <Text size="sm" c="dimmed" mt={4}>
              {t("signing.modal.level.aes-description")}
            </Text>
          </div>

          {/* Signing options */}
          <div>
            <Text size="sm" fw={500} mb={8}>
              Options du document signé
            </Text>
            <Stack gap="xs">
              <Checkbox
                label='Mention diagonale "Bon pour Accord"'
                description="Affiche un filigrane semi-transparent en diagonale sur la dernière page"
                {...form.getInputProps("addApprovalField", { type: "checkbox" })}
              />
              <Checkbox
                label='Mention "Lu et approuvé, le (date)"'
                description="Ajoute la mention avec la date de chaque signature"
                {...form.getInputProps("addApprovalMention", { type: "checkbox" })}
              />
              <Checkbox
                label="Initiales des signataires en bas de chaque page"
                description="Affiche les initiales de chaque signataire en pied de page"
                {...form.getInputProps("addInitials", { type: "checkbox" })}
              />
              {encryptionKey && (
                <>
                  <Divider my="xs" />
                  <Checkbox
                    label={t("signing.option.e2e-key-email")}
                    description={t("signing.option.e2e-key-email.desc")}
                    {...form.getInputProps("sendE2EKeyByEmail", { type: "checkbox" })}
                  />
                </>
              )}
            </Stack>
          </div>

          {/* Recipients */}
          <div>
            <Group justify="space-between" mb="xs">
              <Text size="sm" fw={500}>
                {t("signing.modal.recipients")}
              </Text>
              <Button
                size="compact-xs"
                variant="light"
                leftSection={<TbPlus size={14} />}
                onClick={addRecipient}
              >
                {t("signing.modal.add-recipient")}
              </Button>
            </Group>

            <Stack gap="xs">
              {form.values.recipients.map((_, idx) => (
                <Group key={idx} gap="xs" align="flex-start" wrap="nowrap">
                  <TextInput
                    placeholder={t("signing.modal.recipient.name")}
                    style={{ flex: 1 }}
                    {...form.getInputProps(`recipients.${idx}.name`)}
                  />
                  <TextInput
                    placeholder={t("signing.modal.recipient.email")}
                    style={{ flex: 1.5 }}
                    {...form.getInputProps(`recipients.${idx}.email`)}
                  />
                  <Select
                    data={[
                      { value: "SIGNER", label: t("signing.modal.role.signer") },
                      { value: "APPROVER", label: t("signing.modal.role.approver") },
                      { value: "CC", label: t("signing.modal.role.cc") },
                    ]}
                    style={{ width: 130 }}
                    {...form.getInputProps(`recipients.${idx}.role`)}
                  />
                  <ActionIcon
                    color="red"
                    variant="light"
                    onClick={() => removeRecipient(idx)}
                    disabled={form.values.recipients.length <= 1}
                  >
                    <TbTrash size={16} />
                  </ActionIcon>
                </Group>
              ))}
            </Stack>
          </div>

          {/* Submit */}
          <Group justify="right" mt="md">
            <Button variant="default" onClick={handleClose}>
              {t("common.button.cancel")}
            </Button>
            <Button type="submit" loading={loading || createMutation.isPending}>
              {t("signing.modal.submit")}
            </Button>
          </Group>
        </Stack>
      </form>
      )}
    </Modal>
  );
}
