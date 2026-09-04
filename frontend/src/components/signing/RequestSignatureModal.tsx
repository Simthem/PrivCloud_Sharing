import { useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  CopyButton,
  Divider,
  Group,
  Loader,
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
import type { AxiosError } from "axios";
import {
  TbCheck,
  TbCopy,
  TbLink,
  TbMail,
  TbPlus,
  TbTrash,
} from "react-icons/tb";
import { useIntl } from "react-intl";
import useUser from "../../hooks/user.hook";
import signingService, {
  CreateSignatureRequestPayload,
  SignatureRecipient,
} from "../../services/signing.service";
import shareService from "../../services/share.service";
import toast from "../../utils/toast.util";
import {
  DEFAULT_FIELD_GAP_MM,
  DEFAULT_PDF_PAGE,
  DEFAULT_SIGNATURE_FIELD_MM,
  DEFAULT_TEXT_FIELD_MM,
  PdfFieldPlacement,
  PdfPageLayout,
  clampFieldToPage,
  fieldFitsPage,
  fieldMillimetersToPdfPoints,
  getPlacementInMillimeters,
  pageSizeMillimeters,
} from "../../utils/pdfPlacement.util";

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
  leftMm: number;
  topMm: number;
  widthMm: number;
  heightMm: number;
  required: boolean;
  label: string;
}

const FIELD_PLACEMENTS: { key: PdfFieldPlacement; label: string }[] = [
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

const FALLBACK_PDF_PAGE: PdfPageLayout = {
  ...DEFAULT_PDF_PAGE,
  rotation: 0,
};

export default function RequestSignatureModal({
  opened,
  onClose,
  shareId,
  files,
  encryptionKey,
  teamId,
}: Props) {
  const { user } = useUser();
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });

  const form = useForm({
    initialValues: {
      fileId: files.length === 1 ? files[0].id : "",
      message: "",
      signatureLevel: "STANDARD" as "STANDARD" | "REINFORCED",
      addApprovalField: true,
      addApprovalMention: true,
      addInitials: false,
      initialsPlacement: "BOTTOM_CENTER_RIGHT" as
        | "BOTTOM_LEFT"
        | "BOTTOM_CENTER_RIGHT"
        | "BOTTOM_RIGHT",
      initialsIncludeSignaturePage: false,
      customPageEnabled: false,
      signaturePage: 1,
      watermarkPage: 1,
      watermarkSamePage: true,
      sendE2EKeyByEmail: false,
      recipients: [
        { name: "", email: "", role: "SIGNER" as const },
      ] as RecipientEntry[],
      fields: [] as FieldEntry[],
    },
    validate: {
      fileId: (val: string) =>
        !val ? t("signing.modal.error.file-required") : null,
      recipients: {
        name: (val: string) =>
          !val ? t("signing.modal.error.name-required") : null,
        email: (val: string) =>
          !val || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)
            ? t("signing.modal.error.email-invalid")
            : null,
      },
    },
  });

  const [loading, setLoading] = useState(false);
  const [createdRecipients, setCreatedRecipients] = useState<
    SignatureRecipient[] | null
  >(null);
  const [emailDeliveryFailures, setEmailDeliveryFailures] = useState(0);
  const [pageLayouts, setPageLayouts] = useState<PdfPageLayout[]>([]);
  const [previewPage, setPreviewPage] = useState(1);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  const [pdfLayoutLoading, setPdfLayoutLoading] = useState(false);
  const [pdfLayoutError, setPdfLayoutError] = useState(false);

  const selectedFileId = form.values.fileId;

  // Read the selected PDF so page count, dimensions and preview follow the real
  // document rather than a hard-coded A4 canvas.
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let active = true;

    setPageLayouts([]);
    setPreviewPage(1);
    setPdfPreviewUrl(null);
    setPdfLayoutError(false);
    if (!opened || !selectedFileId) {
      setPdfLayoutLoading(false);
      return () => controller.abort();
    }

    setPdfLayoutLoading(true);
    (async () => {
      try {
        let pdfBytes: ArrayBuffer;
        if (encryptionKey) {
          pdfBytes = await shareService.fetchDecryptedFile(
            shareId,
            selectedFileId,
            encryptionKey,
            controller.signal,
          );
        } else {
          const response = await fetch(
            `/api/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(selectedFileId)}?download=false`,
            { credentials: "include", signal: controller.signal },
          );
          if (!response.ok)
            throw new Error(`PDF preview failed (${response.status})`);
          pdfBytes = await response.arrayBuffer();
        }

        const { PDFDocument } = await import("pdf-lib");
        const pdf = await PDFDocument.load(pdfBytes);
        const layouts = pdf.getPages().map((page) => {
          const { width, height } = page.getSize();
          return {
            widthPoints: width,
            heightPoints: height,
            rotation: page.getRotation().angle,
          };
        });
        if (!active || layouts.length === 0) return;
        objectUrl = URL.createObjectURL(
          new Blob([pdfBytes], { type: "application/pdf" }),
        );
        setPageLayouts(layouts);
        setPdfPreviewUrl(objectUrl);
      } catch {
        if (active && !controller.signal.aborted) setPdfLayoutError(true);
      } finally {
        if (active) setPdfLayoutLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [opened, selectedFileId, shareId, encryptionKey]);

  const getPageLayout = (pageNumber: number) =>
    pageLayouts[Math.max(0, pageNumber - 1)] ||
    pageLayouts[0] ||
    FALLBACK_PDF_PAGE;

  // Fields added while the PDF was still downloading were placed on the A4
  // fallback: bring them back inside the real page once it is measured.
  useEffect(() => {
    if (pageLayouts.length === 0) return;
    form.values.fields.forEach((field, index) => {
      const layout = pageLayouts[Math.max(0, field.page - 1)] || pageLayouts[0];
      const clamped = clampFieldToPage(field, layout);
      if (
        clamped.leftMm !== field.leftMm ||
        clamped.topMm !== field.topMm ||
        clamped.widthMm !== field.widthMm ||
        clamped.heightMm !== field.heightMm
      ) {
        form.setFieldValue(`fields.${index}`, { ...field, ...clamped });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageLayouts]);

  const createMutation = useMutation({
    mutationFn: (data: CreateSignatureRequestPayload) =>
      signingService.createRequest(data),
    onSuccess: (result: any) => {
      toast.success(t("signing.modal.notify.success"));
      setLoading(false);
      setEmailDeliveryFailures(result?.emailDeliveryFailures || 0);
      // Show signing links -> the backend returns recipients with signingToken
      if (result?.recipients?.length) {
        setCreatedRecipients(result.recipients);
      } else {
        handleClose();
      }
    },
    onError: (error: AxiosError<{ message?: string | string[] }>) => {
      const message = error.response?.data?.message;
      toast.error(
        Array.isArray(message)
          ? message.join(" ")
          : message || t("signing.modal.notify.error"),
      );
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

    const signerRecipients = values.recipients.filter(
      (r) => r.role === "SIGNER",
    );
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
    const outsidePage = customFields.find(
      (field) => !fieldFitsPage(field, getPageLayout(field.page)),
    );
    if (outsidePage) {
      toast.error(t("signing.new.validate.field-outside-page"));
      return;
    }

    const targetPage = values.customPageEnabled ? values.signaturePage : 1;
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
            field.recipientEmail.toLowerCase() ===
              recipient.email.toLowerCase() &&
            ["APPROVAL", "TEXT"].includes(field.type),
        );
        const targetLayout = getPageLayout(targetPage);
        const defaultSignaturePosition = getPlacementInMillimeters(
          "bottom-right",
          targetLayout,
          {
            widthMm: DEFAULT_SIGNATURE_FIELD_MM.width,
            heightMm: DEFAULT_SIGNATURE_FIELD_MM.height,
          },
        );
        const placement = clampFieldToPage(
          {
            leftMm: anchorField?.leftMm ?? defaultSignaturePosition.leftMm,
            topMm: anchorField
              ? anchorField.topMm + anchorField.heightMm + DEFAULT_FIELD_GAP_MM
              : defaultSignaturePosition.topMm -
                idx *
                  (DEFAULT_SIGNATURE_FIELD_MM.height + DEFAULT_FIELD_GAP_MM),
            widthMm: DEFAULT_SIGNATURE_FIELD_MM.width,
            heightMm: DEFAULT_SIGNATURE_FIELD_MM.height,
          },
          targetLayout,
        );
        fields.push({
          recipientEmail: recipient.email,
          type: "SIGNATURE",
          page: targetPage,
          ...placement,
          required: true,
          label: "",
        });
      }
    });

    setLoading(true);

    const payloadFields = fields.map((field) => ({
      assignedRecipientEmail: field.recipientEmail || undefined,
      type: field.type,
      page: field.page,
      ...fieldMillimetersToPdfPoints(field, getPageLayout(field.page)),
      required: field.required,
      label: field.label || undefined,
    }));

    const shouldEmailE2EKey = Boolean(
      encryptionKey && values.sendE2EKeyByEmail,
    );

    createMutation.mutate({
      notificationCreatorId: user?.id,
      notificationE2EKey: encryptionKey || undefined,
      shareId,
      fileId: values.fileId,
      message: values.message || undefined,
      signatureLevel: values.signatureLevel,
      addApprovalField: values.addApprovalField,
      addApprovalMention: values.addApprovalMention,
      addInitials: values.addInitials,
      initialsPlacement: values.initialsPlacement,
      initialsIncludeSignaturePage: values.initialsIncludeSignaturePage,
      signaturePage: values.customPageEnabled
        ? values.signaturePage
        : undefined,
      watermarkPage:
        values.addApprovalField &&
        values.customPageEnabled &&
        !values.watermarkSamePage
          ? values.watermarkPage
          : undefined,
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

  const buildField = (type: FieldEntry["type"] = "SIGNATURE"): FieldEntry => {
    const firstSigner = form.values.recipients.find((r) => r.role === "SIGNER");
    const textLike = ["TEXT", "APPROVAL"].includes(type);
    const dimensions = textLike
      ? DEFAULT_TEXT_FIELD_MM
      : DEFAULT_SIGNATURE_FIELD_MM;
    const page = form.values.customPageEnabled ? form.values.signaturePage : 1;
    const pageLayout = getPageLayout(page);
    const bottomRight = getPlacementInMillimeters("bottom-right", pageLayout, {
      widthMm: dimensions.width,
      heightMm: dimensions.height,
    });
    return {
      recipientEmail: firstSigner?.email || "",
      type,
      page,
      ...clampFieldToPage(
        {
          ...bottomRight,
          widthMm: dimensions.width,
          heightMm: dimensions.height,
          topMm: textLike
            ? bottomRight.topMm -
              DEFAULT_SIGNATURE_FIELD_MM.height -
              DEFAULT_FIELD_GAP_MM
            : bottomRight.topMm,
        },
        pageLayout,
      ),
      required: true,
      label:
        type === "APPROVAL" ? t("signing.new.fields.approval.default") : "",
    };
  };

  const addField = (type: FieldEntry["type"] = "SIGNATURE") => {
    form.insertListItem("fields", buildField(type));
  };

  const applyFieldPlacement = (index: number, placement: PdfFieldPlacement) => {
    const field = form.values.fields[index];
    if (!field) return;
    const coordinates = getPlacementInMillimeters(
      placement,
      getPageLayout(field.page),
      field,
    );
    const textLike = ["TEXT", "APPROVAL"].includes(field.type);
    form.setFieldValue(`fields.${index}.leftMm`, coordinates.leftMm);
    form.setFieldValue(
      `fields.${index}.topMm`,
      textLike && placement.startsWith("bottom")
        ? Math.max(
            0,
            coordinates.topMm -
              DEFAULT_SIGNATURE_FIELD_MM.height -
              DEFAULT_FIELD_GAP_MM,
          )
        : coordinates.topMm,
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
      title={
        createdRecipients ? "Liens de signature" : t("signing.modal.title")
      }
      size="xl"
    >
      {createdRecipients ? (
        <Stack gap="md">
          <Alert
            color={emailDeliveryFailures > 0 ? "yellow" : "green"}
            icon={<TbMail size={16} />}
          >
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
                      <Text size="md" fw={600}>
                        {r.name}
                      </Text>
                      <Text size="sm" c="dimmed">
                        {r.email}
                      </Text>
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
                        <ActionIcon
                          color={copied ? "green" : "blue"}
                          variant="light"
                          onClick={copy}
                          size="lg"
                        >
                          {copied ? (
                            <TbCheck size={16} />
                          ) : (
                            <TbCopy size={16} />
                          )}
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
              <Select
                label={t("signing.modal.level")}
                data={[
                  { value: "STANDARD", label: t("signing.modal.level.aes") },
                  { value: "REINFORCED", label: t("signing.modal.level.qes") },
                ]}
                allowDeselect={false}
                {...form.getInputProps("signatureLevel")}
              />
              <Text size="sm" c="dimmed" mt={4}>
                {form.values.signatureLevel === "REINFORCED"
                  ? t("signing.modal.level.qes-description")
                  : t("signing.modal.level.aes-description")}
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
                  {...form.getInputProps("addApprovalField", {
                    type: "checkbox",
                  })}
                />
                <Checkbox
                  label='Mention "Lu et approuvé, le (date)"'
                  description="Ajoute la mention avec la date de chaque signature"
                  {...form.getInputProps("addApprovalMention", {
                    type: "checkbox",
                  })}
                />
                <Checkbox
                  label="Initiales des signataires en bas de chaque page"
                  description="Affiche les initiales de chaque signataire en pied de page"
                  {...form.getInputProps("addInitials", { type: "checkbox" })}
                />
                {form.values.addInitials && (
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                    <Select
                      label={t("signing.new.option.initials.placement")}
                      data={[
                        {
                          value: "BOTTOM_LEFT",
                          label: t("signing.new.option.initials.bottom-left"),
                        },
                        {
                          value: "BOTTOM_CENTER_RIGHT",
                          label: t(
                            "signing.new.option.initials.bottom-center-right",
                          ),
                        },
                        {
                          value: "BOTTOM_RIGHT",
                          label: t("signing.new.option.initials.bottom-right"),
                        },
                      ]}
                      allowDeselect={false}
                      {...form.getInputProps("initialsPlacement")}
                    />
                    <Checkbox
                      mt={26}
                      label={t(
                        "signing.new.option.initials.include-signature-page",
                      )}
                      {...form.getInputProps("initialsIncludeSignaturePage", {
                        type: "checkbox",
                      })}
                    />
                  </SimpleGrid>
                )}
                {encryptionKey && (
                  <>
                    <Divider my="xs" />
                    <Checkbox
                      label={t("signing.option.e2e-key-email")}
                      description={t("signing.option.e2e-key-email.desc")}
                      {...form.getInputProps("sendE2EKeyByEmail", {
                        type: "checkbox",
                      })}
                    />
                  </>
                )}
                <Divider my="xs" />
                <Checkbox
                  label={t("signing.modal.custom-page")}
                  description={t("signing.modal.custom-page.desc")}
                  {...form.getInputProps("customPageEnabled", {
                    type: "checkbox",
                  })}
                />
                {form.values.customPageEnabled && (
                  <>
                    <NumberInput
                      label={t("signing.modal.custom-page.signature-label")}
                      description={t("signing.modal.custom-page.hint")}
                      min={1}
                      max={9999}
                      style={{ maxWidth: 200 }}
                      {...form.getInputProps("signaturePage")}
                    />
                    {form.values.addApprovalField && (
                      <>
                        <Checkbox
                          label={t("signing.modal.custom-page.watermark-same")}
                          {...form.getInputProps("watermarkSamePage", {
                            type: "checkbox",
                          })}
                        />
                        {!form.values.watermarkSamePage && (
                          <NumberInput
                            label={t(
                              "signing.modal.custom-page.watermark-label",
                            )}
                            description={t("signing.modal.custom-page.hint")}
                            min={1}
                            max={9999}
                            style={{ maxWidth: 200 }}
                            {...form.getInputProps("watermarkPage")}
                          />
                        )}
                      </>
                    )}
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
                        {
                          value: "SIGNER",
                          label: t("signing.modal.role.signer"),
                        },
                        {
                          value: "APPROVER",
                          label: t("signing.modal.role.approver"),
                        },
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

              {pdfLayoutLoading && (
                <Group gap="xs" mb="xs">
                  <Loader size="xs" />
                  <Text size="sm" c="dimmed">
                    {t("signing.new.fields.preview.loading")}
                  </Text>
                </Group>
              )}
              {pdfLayoutError && (
                <Alert color="orange" mb="xs">
                  {t("signing.new.fields.preview.error")}
                </Alert>
              )}
              {pageLayouts.length > 0 && (
                <Paper withBorder p="sm" mb="xs">
                  <Stack gap="sm">
                    <Group justify="space-between" align="flex-end">
                      <div>
                        <Text size="sm" fw={600}>
                          {t("signing.new.fields.preview.title")}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {intl.formatMessage(
                            { id: "signing.new.fields.preview.dimensions" },
                            {
                              width: pageSizeMillimeters(
                                getPageLayout(previewPage),
                              ).widthMm,
                              height: pageSizeMillimeters(
                                getPageLayout(previewPage),
                              ).heightMm,
                            },
                          )}
                        </Text>
                      </div>
                      <NumberInput
                        label={t("signing.new.fields.preview.page")}
                        min={1}
                        max={pageLayouts.length}
                        value={previewPage}
                        onChange={(value) =>
                          setPreviewPage(
                            Math.min(
                              pageLayouts.length,
                              Math.max(1, Number(value) || 1),
                            ),
                          )
                        }
                        style={{ width: 100 }}
                      />
                    </Group>
                    {getPageLayout(previewPage).rotation % 360 !== 0 && (
                      <Alert color="orange">
                        {t("signing.new.fields.preview.rotated")}
                      </Alert>
                    )}
                    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                      {pdfPreviewUrl && (
                        <Box
                          component="iframe"
                          title={t("signing.new.fields.preview.document")}
                          src={`${pdfPreviewUrl}#page=${previewPage}&view=FitH`}
                          style={{
                            width: "100%",
                            minHeight: 360,
                            border:
                              "1px solid var(--mantine-color-default-border)",
                            borderRadius: 6,
                          }}
                        />
                      )}
                      <Box
                        style={{
                          position: "relative",
                          width: "100%",
                          maxWidth: 320,
                          aspectRatio: `${getPageLayout(previewPage).widthPoints} / ${getPageLayout(previewPage).heightPoints}`,
                          marginInline: "auto",
                          background: "white",
                          border: "1px solid var(--mantine-color-gray-4)",
                          boxShadow: "var(--mantine-shadow-sm)",
                          overflow: "hidden",
                        }}
                      >
                        {form.values.fields
                          .filter((field) => field.page === previewPage)
                          .map((field, index) => {
                            const size = pageSizeMillimeters(
                              getPageLayout(previewPage),
                            );
                            return (
                              <Box
                                key={`${field.type}-${index}`}
                                style={{
                                  position: "absolute",
                                  left: `${(field.leftMm / size.widthMm) * 100}%`,
                                  top: `${(field.topMm / size.heightMm) * 100}%`,
                                  width: `${(field.widthMm / size.widthMm) * 100}%`,
                                  height: `${(field.heightMm / size.heightMm) * 100}%`,
                                  border:
                                    "2px solid var(--mantine-color-blue-6)",
                                  background: "rgba(34, 139, 230, 0.14)",
                                  color: "var(--mantine-color-dark-9)",
                                  fontSize: 10,
                                  padding: 2,
                                  overflow: "hidden",
                                }}
                              >
                                {t(
                                  `signing.new.fields.type.${field.type.toLowerCase()}`,
                                )}
                              </Box>
                            );
                          })}
                      </Box>
                    </SimpleGrid>
                  </Stack>
                </Paper>
              )}

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
                              .filter(
                                (recipient) => recipient.role === "SIGNER",
                              )
                              .map((recipient) => ({
                                value: recipient.email,
                                label: recipient.name || recipient.email,
                              }))}
                            {...form.getInputProps(
                              `fields.${idx}.recipientEmail`,
                            )}
                          />
                          <Select
                            label={t("signing.new.fields.type")}
                            data={[
                              {
                                value: "SIGNATURE",
                                label: t("signing.new.fields.type.signature"),
                              },
                              {
                                value: "INITIALS",
                                label: t("signing.new.fields.type.initials"),
                              },
                              {
                                value: "DATE",
                                label: t("signing.new.fields.type.date"),
                              },
                              {
                                value: "TEXT",
                                label: t("signing.new.fields.type.text"),
                              },
                              {
                                value: "APPROVAL",
                                label: t("signing.new.fields.type.approval"),
                              },
                            ]}
                            {...form.getInputProps(`fields.${idx}.type`)}
                          />
                        </SimpleGrid>
                        {textLike && (
                          <Textarea
                            label={t("signing.new.fields.label")}
                            placeholder={
                              field.type === "APPROVAL"
                                ? t(
                                    "signing.new.fields.label.approval-placeholder",
                                  )
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
                            label={t("signing.new.fields.left-mm")}
                            min={0}
                            decimalScale={1}
                            step={0.1}
                            style={{ width: 120 }}
                            {...form.getInputProps(`fields.${idx}.leftMm`)}
                          />
                          <NumberInput
                            label={t("signing.new.fields.top-mm")}
                            min={0}
                            decimalScale={1}
                            step={0.1}
                            style={{ width: 120 }}
                            {...form.getInputProps(`fields.${idx}.topMm`)}
                          />
                          <NumberInput
                            label={t("signing.new.fields.width-mm")}
                            min={0.1}
                            decimalScale={1}
                            step={0.1}
                            style={{ width: 130 }}
                            {...form.getInputProps(`fields.${idx}.widthMm`)}
                          />
                          <NumberInput
                            label={t("signing.new.fields.height-mm")}
                            min={0.1}
                            decimalScale={1}
                            step={0.1}
                            style={{ width: 130 }}
                            {...form.getInputProps(`fields.${idx}.heightMm`)}
                          />
                          <Checkbox
                            label={t("signing.new.fields.required")}
                            {...form.getInputProps(`fields.${idx}.required`, {
                              type: "checkbox",
                            })}
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
                                onClick={() =>
                                  applyFieldPlacement(idx, placement.key)
                                }
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
              <Button
                type="submit"
                loading={loading || createMutation.isPending}
              >
                {t("signing.modal.submit")}
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}
