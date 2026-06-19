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
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
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

interface FieldEntry {
  recipientEmail: string;
  type: "SIGNATURE" | "INITIALS" | "DATE" | "TEXT" | "APPROVAL";
  page: number;
  posX: number;
  posY: number;
  width: number;
  height: number;
  required: boolean;
  label: string;
}

type FieldPlacement =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

const A4_WIDTH = 595;
const A4_HEIGHT = 842;
const PAGE_MARGIN = 36;
const SIGNATURE_FIELD_WIDTH = 240;
const SIGNATURE_FIELD_HEIGHT = 80;
const TEXT_FIELD_WIDTH = 240;
const TEXT_FIELD_HEIGHT = 90;
const FIELD_GAP = 12;

const FIELD_PLACEMENTS: { key: FieldPlacement; label: string }[] = [
  { key: "top-left", label: "signing.new.fields.placement.top-left" },
  { key: "top-center", label: "signing.new.fields.placement.top-center" },
  { key: "top-right", label: "signing.new.fields.placement.top-right" },
  { key: "middle-left", label: "signing.new.fields.placement.middle-left" },
  { key: "middle-center", label: "signing.new.fields.placement.middle-center" },
  { key: "middle-right", label: "signing.new.fields.placement.middle-right" },
  { key: "bottom-left", label: "signing.new.fields.placement.bottom-left" },
  { key: "bottom-center", label: "signing.new.fields.placement.bottom-center" },
  { key: "bottom-right", label: "signing.new.fields.placement.bottom-right" },
];

const getPlacementCoordinates = (
  placement: FieldPlacement,
  width: number,
  height: number,
) => {
  const horizontal = placement.split("-")[1];
  const vertical = placement.split("-")[0];
  const posX =
    horizontal === "left"
      ? PAGE_MARGIN
      : horizontal === "center"
        ? (A4_WIDTH - width) / 2
        : A4_WIDTH - width - PAGE_MARGIN;
  const posY =
    vertical === "top"
      ? A4_HEIGHT - height - PAGE_MARGIN
      : vertical === "middle"
        ? (A4_HEIGHT - height) / 2
        : PAGE_MARGIN;
  return { posX: Math.round(posX), posY: Math.round(posY) };
};

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
      fields: [] as FieldEntry[],
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

    const signerRecipients = values.recipients.filter((r) => r.role === "SIGNER");
    const defaultRecipientEmail = signerRecipients[0]?.email || "";
    const customFields = values.fields.map((field) => ({
      ...field,
      recipientEmail: field.recipientEmail || defaultRecipientEmail,
      label: field.label.trim(),
    }));
    const missingInstruction = customFields.find(
      (field) =>
        ["TEXT", "APPROVAL"].includes(field.type) &&
        field.required &&
        !field.label,
    );
    if (missingInstruction) {
      toast.error(t("signing.new.validate.field-label-required"));
      return;
    }

    const fields = [...customFields];
    signerRecipients.forEach((recipient, idx) => {
      const alreadyHasSignature = fields.some(
        (field) =>
          field.type === "SIGNATURE" &&
          field.recipientEmail.toLowerCase() === recipient.email.toLowerCase(),
      );
      if (!alreadyHasSignature) {
        const anchorField = fields.find(
          (field) =>
            field.recipientEmail.toLowerCase() === recipient.email.toLowerCase() &&
            ["APPROVAL", "TEXT"].includes(field.type),
        );
        const defaultSignaturePosition = getPlacementCoordinates(
          "bottom-right",
          SIGNATURE_FIELD_WIDTH,
          SIGNATURE_FIELD_HEIGHT,
        );
        fields.push({
          recipientEmail: recipient.email,
          type: "SIGNATURE",
          page: 1,
          posX: anchorField?.posX ?? defaultSignaturePosition.posX,
          posY: anchorField
            ? Math.max(PAGE_MARGIN, anchorField.posY - SIGNATURE_FIELD_HEIGHT - FIELD_GAP)
            : defaultSignaturePosition.posY + idx * (SIGNATURE_FIELD_HEIGHT + FIELD_GAP),
          width: SIGNATURE_FIELD_WIDTH,
          height: SIGNATURE_FIELD_HEIGHT,
          required: true,
          label: "",
        });
      }
    });

    const payloadFields = fields.map((field) => ({
      assignedRecipientEmail: field.recipientEmail || undefined,
      type: field.type,
      page: field.page,
      posX: field.posX,
      posY: field.posY,
      width: field.width,
      height: field.height,
      required: field.required,
      label: field.label || undefined,
    }));

    setLoading(true);

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
      fields: payloadFields,
    });
  };

  const buildField = (
    type: FieldEntry["type"] = "SIGNATURE",
  ): FieldEntry => {
    const firstSigner = form.values.recipients.find((r) => r.role === "SIGNER");
    const textLike = ["TEXT", "APPROVAL"].includes(type);
    const width = textLike ? TEXT_FIELD_WIDTH : SIGNATURE_FIELD_WIDTH;
    const height = textLike ? TEXT_FIELD_HEIGHT : SIGNATURE_FIELD_HEIGHT;
    const bottomRight = getPlacementCoordinates("bottom-right", width, height);
    return {
      recipientEmail: firstSigner?.email || "",
      type,
      page: 1,
      posX: bottomRight.posX,
      posY: textLike
        ? bottomRight.posY + SIGNATURE_FIELD_HEIGHT + FIELD_GAP
        : bottomRight.posY,
      width,
      height,
      required: true,
      label:
        type === "APPROVAL"
          ? t("signing.new.fields.approval.default")
          : "",
    };
  };

  const addField = (type: FieldEntry["type"] = "SIGNATURE") => {
    form.insertListItem("fields", buildField(type));
  };

  const applyFieldPlacement = (index: number, placement: FieldPlacement) => {
    const field = form.values.fields[index];
    if (!field) return;
    const { posX, posY } = getPlacementCoordinates(
      placement,
      field.width,
      field.height,
    );
    const textLike = ["TEXT", "APPROVAL"].includes(field.type);
    form.setFieldValue(`fields.${index}.posX`, posX);
    form.setFieldValue(
      `fields.${index}.posY`,
      textLike && placement.startsWith("bottom")
        ? posY + SIGNATURE_FIELD_HEIGHT + FIELD_GAP
        : posY,
    );
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
      size="xl"
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

          {/* Custom fields */}
          <div>
            <Group justify="space-between" mb="xs" align="center">
              <div>
                <Text size="sm" fw={500}>
                  {t("signing.new.fields")}
                </Text>
                <Text size="xs" c="dimmed">
                  {t("signing.new.fields.desc")}
                </Text>
              </div>
              <Group gap="xs">
                <Button
                  size="compact-xs"
                  variant="light"
                  leftSection={<TbPlus size={14} />}
                  onClick={() => addField("TEXT")}
                >
                  {t("signing.new.fields.add-text")}
                </Button>
                <Button
                  size="compact-xs"
                  variant="light"
                  leftSection={<TbPlus size={14} />}
                  onClick={() => addField("APPROVAL")}
                >
                  {t("signing.new.fields.add-approval")}
                </Button>
                <Button
                  size="compact-xs"
                  variant="light"
                  leftSection={<TbPlus size={14} />}
                  onClick={() => addField("SIGNATURE")}
                >
                  {t("signing.new.fields.add-signature")}
                </Button>
              </Group>
            </Group>

            <Stack gap="xs">
              {form.values.fields.map((field, idx) => {
                const textLike = ["TEXT", "APPROVAL"].includes(field.type);
                return (
                  <Paper key={idx} withBorder p="sm">
                    <Stack gap="xs">
                      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                        <Select
                          label={t("signing.new.fields.signer")}
                          data={form.values.recipients
                            .filter((recipient) => recipient.role === "SIGNER")
                            .map((recipient) => ({
                              value: recipient.email,
                              label: recipient.name || recipient.email,
                            }))}
                          {...form.getInputProps(`fields.${idx}.recipientEmail`)}
                        />
                        <Select
                          label={t("signing.new.fields.type")}
                          data={[
                            { value: "SIGNATURE", label: t("signing.new.fields.type.signature") },
                            { value: "INITIALS", label: t("signing.new.fields.type.initials") },
                            { value: "DATE", label: t("signing.new.fields.type.date") },
                            { value: "TEXT", label: t("signing.new.fields.type.text") },
                            { value: "APPROVAL", label: t("signing.new.fields.type.approval") },
                          ]}
                          {...form.getInputProps(`fields.${idx}.type`)}
                        />
                      </SimpleGrid>
                      {textLike && (
                        <Textarea
                          label={t("signing.new.fields.label")}
                          placeholder={
                            field.type === "APPROVAL"
                              ? t("signing.new.fields.label.approval-placeholder")
                              : t("signing.new.fields.label.placeholder")
                          }
                          autosize
                          minRows={field.type === "APPROVAL" ? 2 : 1}
                          required={field.required}
                          {...form.getInputProps(`fields.${idx}.label`)}
                        />
                      )}
                      <Group align="flex-end" wrap="wrap">
                        <NumberInput
                          label={t("signing.new.fields.page")}
                          min={1}
                          max={9999}
                          style={{ width: 90 }}
                          {...form.getInputProps(`fields.${idx}.page`)}
                        />
                        <NumberInput
                          label="X"
                          min={0}
                          max={10000}
                          style={{ width: 80 }}
                          {...form.getInputProps(`fields.${idx}.posX`)}
                        />
                        <NumberInput
                          label="Y"
                          min={0}
                          max={10000}
                          style={{ width: 80 }}
                          {...form.getInputProps(`fields.${idx}.posY`)}
                        />
                        <NumberInput
                          label={t("signing.new.fields.width")}
                          min={1}
                          max={10000}
                          style={{ width: 100 }}
                          {...form.getInputProps(`fields.${idx}.width`)}
                        />
                        <NumberInput
                          label={t("signing.new.fields.height")}
                          min={1}
                          max={10000}
                          style={{ width: 100 }}
                          {...form.getInputProps(`fields.${idx}.height`)}
                        />
                        <Checkbox
                          label={t("signing.new.fields.required")}
                          {...form.getInputProps(`fields.${idx}.required`, { type: "checkbox" })}
                        />
                        <ActionIcon
                          color="red"
                          variant="subtle"
                          onClick={() => form.removeListItem("fields", idx)}
                        >
                          <TbTrash size={16} />
                        </ActionIcon>
                      </Group>
                      <Stack gap={4}>
                        <Text size="xs" fw={500}>
                          {t("signing.new.fields.placement")}
                        </Text>
                        <Group gap={4}>
                          {FIELD_PLACEMENTS.map((placement) => (
                            <Button
                              key={placement.key}
                              size="compact-xs"
                              variant="subtle"
                              onClick={() => applyFieldPlacement(idx, placement.key)}
                            >
                              {t(placement.label)}
                            </Button>
                          ))}
                        </Group>
                      </Stack>
                    </Stack>
                  </Paper>
                );
              })}
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
