import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AxiosError } from "axios";
import { useRouter } from "next/router";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Container,
  CopyButton,
  Divider,
  Group,
  Loader,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import {
  TbCheck,
  TbCopy,
  TbLink,
  TbMail,
  TbPlus,
  TbTrash,
  TbShieldCheck,
  TbSend,
} from "react-icons/tb";
import Meta from "../../components/Meta";
import useUser from "../../hooks/user.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import signingService, {
  CreateSignatureRequestPayload,
  SignatureRecipient,
} from "../../services/signing.service";
import teamService from "../../services/team.service";
import shareService from "../../services/share.service";
import toast from "../../utils/toast.util";
import {
  getUserKey,
  importKeyFromBase64,
  exportKeyToBase64,
  unwrapReverseShareKey,
} from "../../utils/crypto.util";
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

interface RecipientForm {
  name: string;
  email: string;
  role: "SIGNER" | "CC" | "APPROVER";
  order?: number;
}

interface FieldForm {
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

const NewSigningRequestPage = () => {
  const router = useRouter();
  const { user } = useUser();
  const t = useTranslate();

  const [createdRecipients, setCreatedRecipients] = useState<
    SignatureRecipient[] | null
  >(null);
  const [createdRequestId, setCreatedRequestId] = useState<string | null>(null);
  const [teamKeyB64, setTeamKeyB64] = useState<string | null>(null);
  const [pageLayouts, setPageLayouts] = useState<PdfPageLayout[]>([]);
  const [previewPage, setPreviewPage] = useState(1);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  const [pdfLayoutLoading, setPdfLayoutLoading] = useState(false);
  const [pdfLayoutError, setPdfLayoutError] = useState(false);

  useEffect(() => {
    if (user === null) {
      router.replace("/auth/signIn?redirect=/signing/new");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Fetch signable files from all teams
  const { data: signableFiles, isLoading: filesLoading } = useQuery({
    queryKey: ["signableFiles"],
    queryFn: teamService.getSignableFiles,
    enabled: !!user,
  });

  // Build Select data grouped by team > folder
  const fileSelectData = useMemo(() => {
    if (!signableFiles || signableFiles.length === 0) return [];
    const groups: Record<string, { value: string; label: string }[]> = {};
    for (const f of signableFiles) {
      const groupLabel = `${f.teamName} / ${f.folderName}`;
      if (!groups[groupLabel]) groups[groupLabel] = [];
      groups[groupLabel].push({
        value: `${f.shareId}::${f.fileId}`,
        label: f.fileName,
      });
    }
    return Object.entries(groups).map(([group, items]) => ({
      group,
      items,
    }));
  }, [signableFiles]);

  const form = useForm({
    initialValues: {
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
      selectedFile: "" as string,
      shareId: "",
      fileId: "",
      recipients: [
        { name: "", email: "", role: "SIGNER" as const, order: 1 },
      ] as RecipientForm[],
      fields: [] as FieldForm[],
    },
    validate: {
      selectedFile: (val: string) =>
        !val ? t("signing.new.validate.file-required") : null,
      recipients: {
        name: (val: string) =>
          !val ? t("signing.new.validate.name-required") : null,
        email: (val: string) =>
          !val || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)
            ? t("signing.new.validate.email-invalid")
            : null,
      },
    },
  });

  // Resolve team E2E key when the selected file changes
  const selectedFileValue = form.values.selectedFile;
  const selectedFileEntry = useMemo(() => {
    if (!selectedFileValue || !signableFiles) return undefined;
    const [shareId, fileId] = selectedFileValue.split("::");
    return signableFiles.find(
      (file) => file.shareId === shareId && file.fileId === fileId,
    );
  }, [selectedFileValue, signableFiles]);

  useEffect(() => {
    if (!selectedFileValue || !signableFiles) {
      setTeamKeyB64(null);
      return;
    }
    const [shareId, fileId] = selectedFileValue.split("::");
    const fileEntry = signableFiles.find(
      (file) => file.shareId === shareId && file.fileId === fileId,
    );
    if (!fileEntry) {
      setTeamKeyB64(null);
      return;
    }
    if (!fileEntry.isE2EEncrypted) {
      setTeamKeyB64(null);
      return;
    }
    setTeamKeyB64(null);

    let cancelled = false;
    (async () => {
      try {
        const userKeyB64 = getUserKey();
        if (!userKeyB64) return;
        const { wrappedTeamKey } = await teamService.getTeamKey(
          fileEntry.teamId,
        );
        if (cancelled || !wrappedTeamKey) return;
        const masterKey = await importKeyFromBase64(userKeyB64);
        const teamKey = await unwrapReverseShareKey(wrappedTeamKey, masterKey);
        const keyB64 = await exportKeyToBase64(teamKey);
        if (!cancelled) setTeamKeyB64(keyB64);
      } catch {
        // Fallback to user key
        const userKeyB64 = getUserKey();
        if (!cancelled && userKeyB64) setTeamKeyB64(userKeyB64);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFileValue, signableFiles]);

  // Read the selected PDF itself so page count, dimensions and preview match
  // the document rather than a hard-coded A4 canvas.
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let active = true;

    setPageLayouts([]);
    setPreviewPage(1);
    setPdfPreviewUrl(null);
    setPdfLayoutError(false);
    if (!selectedFileEntry) {
      setPdfLayoutLoading(false);
      return () => controller.abort();
    }
    if (selectedFileEntry.isE2EEncrypted && !teamKeyB64) {
      setPdfLayoutLoading(true);
      return () => controller.abort();
    }

    setPdfLayoutLoading(true);
    (async () => {
      try {
        let pdfBytes: ArrayBuffer;
        if (selectedFileEntry.isE2EEncrypted) {
          pdfBytes = await shareService.fetchDecryptedFile(
            selectedFileEntry.shareId,
            selectedFileEntry.fileId,
            teamKeyB64!,
            controller.signal,
          );
        } else {
          const response = await fetch(
            `/api/shares/${encodeURIComponent(selectedFileEntry.shareId)}/files/${encodeURIComponent(selectedFileEntry.fileId)}?download=false`,
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
        if (active && !controller.signal.aborted) {
          setPdfLayoutError(true);
        }
      } finally {
        if (active) setPdfLayoutLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selectedFileEntry, teamKeyB64]);

  const createMutation = useMutation({
    mutationFn: (data: CreateSignatureRequestPayload) =>
      signingService.createRequest(data),
    onSuccess: (result: any) => {
      toast.success(t("signing.toast.created"));
      // Show signing links inline (with encryption key) instead of redirecting
      if (result?.recipients?.length) {
        setCreatedRecipients(result.recipients);
        setCreatedRequestId(result.id || null);
      } else if (result?.id) {
        router.push(`/signing/${result.id}`);
      } else {
        router.push("/signing");
      }
    },
    onError: (error: AxiosError<{ message?: string | string[] }>) => {
      const message = error.response?.data?.message;
      toast.error(
        Array.isArray(message)
          ? message.join(" ")
          : message || t("signing.toast.create-error"),
      );
    },
  });

  const addRecipient = () => {
    form.insertListItem("recipients", {
      name: "",
      email: "",
      role: "SIGNER",
      order: form.values.recipients.length + 1,
    });
  };

  const removeRecipient = (index: number) => {
    form.removeListItem("recipients", index);
  };

  const getPageLayout = (pageNumber: number) =>
    pageLayouts[Math.max(0, pageNumber - 1)] ||
    pageLayouts[0] ||
    FALLBACK_PDF_PAGE;

  const addField = (type: FieldForm["type"] = "SIGNATURE") => {
    const firstRecipient =
      form.values.recipients.find((r) => r.role === "SIGNER")?.email || "";
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
    const initialPlacement = clampFieldToPage(
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
    );
    form.insertListItem("fields", {
      recipientEmail: firstRecipient,
      type,
      page,
      ...initialPlacement,
      required: true,
      label:
        type === "APPROVAL" ? t("signing.new.fields.approval.default") : "",
    });
  };

  const handleSubmit = (values: typeof form.values) => {
    if (values.recipients.length === 0) {
      toast.error(t("signing.new.validate.min-signer"));
      return;
    }

    // Derive shareId and fileId from the selected file
    const [shareId, fileId] = values.selectedFile.split("::");
    if (!shareId || !fileId) {
      toast.error(t("signing.new.validate.file-required"));
      return;
    }

    // Resolve teamId from selected file
    const fileEntry = signableFiles?.find(
      (f) => f.shareId === shareId && f.fileId === fileId,
    );
    const shouldEmailE2EKey = Boolean(
      fileEntry?.isE2EEncrypted && teamKeyB64 && values.sendE2EKeyByEmail,
    );

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

    const fields = [...customFields];
    const targetPage = values.customPageEnabled ? values.signaturePage : 1;
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

    createMutation.mutate({
      notificationCreatorId: user?.id,
      notificationE2EKey: teamKeyB64 || undefined,
      shareId,
      fileId,
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
      isE2EEncrypted: fileEntry?.isE2EEncrypted === true,
      sendE2EKeyByEmail: shouldEmailE2EKey,
      e2eKey: shouldEmailE2EKey ? teamKeyB64 || undefined : undefined,
      teamId: fileEntry?.teamId || undefined,
      recipients: values.recipients.map((r) => ({
        name: r.name,
        email: r.email,
        role: r.role,
        order: r.order,
      })),
      fields: fields.map((field) => {
        const points = fieldMillimetersToPdfPoints(
          field,
          getPageLayout(field.page),
        );
        return {
          assignedRecipientEmail: field.recipientEmail,
          type: field.type,
          page: field.page,
          ...points,
          required: field.required,
          label: field.label || undefined,
        };
      }),
    });
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

  return (
    <>
      <Meta title={t("signing.new.title")} />
      <Container size="md" mt="xl" mb="xl" px={0}>
        <Group gap="xs" mb="lg" align="center" wrap="nowrap">
          <TbShieldCheck size={26} />
          <Title order={2}>{t("signing.new.title")}</Title>
        </Group>

        {/* After creation: show signing links with encryption key */}
        {createdRecipients ? (
          <Stack gap="lg">
            <Alert color="green" icon={<TbMail size={16} />}>
              {t("signing.new.created-alert")}
            </Alert>
            {createdRecipients
              .filter((r) => r.signingToken && r.role !== "CC")
              .map((r) => {
                const keyFragment = teamKeyB64 ? `#key=${teamKeyB64}` : "";
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
                        {r.role === "SIGNER"
                          ? t("signing.role.signer")
                          : t("signing.role.approver")}
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
            <Group justify="center" gap="md">
              {createdRequestId && (
                <Button
                  variant="light"
                  onClick={() => router.push(`/signing/${createdRequestId}`)}
                >
                  {t("signing.new.view-detail")}
                </Button>
              )}
              <Button
                variant="subtle"
                onClick={() => {
                  setCreatedRecipients(null);
                  setCreatedRequestId(null);
                  form.reset();
                }}
              >
                {t("signing.new.create-another")}
              </Button>
            </Group>
          </Stack>
        ) : (
          <form onSubmit={form.onSubmit(handleSubmit)}>
            <Stack gap="lg">
              {/* Document info */}
              <Paper withBorder p="lg">
                <Stack gap="md">
                  <Title order={4}>{t("signing.document")}</Title>
                  {filesLoading ? (
                    <Group gap="xs">
                      <Loader size="xs" />
                      <Text size="sm" c="dimmed">
                        {t("signing.new.loading-files")}
                      </Text>
                    </Group>
                  ) : fileSelectData.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      {t("signing.new.no-signable-files")}
                    </Text>
                  ) : (
                    <Select
                      label={t("signing.new.select-file")}
                      description={t("signing.new.select-file.desc")}
                      placeholder={t("signing.new.select-file.placeholder")}
                      data={fileSelectData}
                      searchable
                      required
                      {...form.getInputProps("selectedFile")}
                    />
                  )}
                  <Textarea
                    label={t("signing.new.message")}
                    placeholder={t("signing.new.message.placeholder")}
                    {...form.getInputProps("message")}
                  />
                </Stack>
              </Paper>

              {/* Signature level */}
              <Paper withBorder p="lg">
                <Stack gap="md">
                  <Title order={4}>{t("signing.new.eidas-level")}</Title>
                  <Text size="xs" c="dimmed">
                    {t("signing.new.eidas-desc")}
                  </Text>
                  <Select
                    label={t("signing.modal.level")}
                    data={[
                      {
                        value: "STANDARD",
                        label: t("signing.modal.level.aes"),
                      },
                      {
                        value: "REINFORCED",
                        label: t("signing.modal.level.qes"),
                      },
                    ]}
                    allowDeselect={false}
                    {...form.getInputProps("signatureLevel")}
                  />
                  <Alert
                    color={
                      form.values.signatureLevel === "REINFORCED"
                        ? "violet"
                        : "blue"
                    }
                  >
                    {form.values.signatureLevel === "REINFORCED"
                      ? t("signing.modal.level.qes-description")
                      : t("signing.modal.level.aes-description")}
                  </Alert>
                </Stack>
              </Paper>

              {/* Signing options */}
              <Paper withBorder p="lg">
                <Stack gap="md">
                  <Title order={4}>{t("signing.new.options")}</Title>
                  <Checkbox
                    label={t("signing.new.option.approval-field")}
                    description={t("signing.new.option.approval-field.desc")}
                    {...form.getInputProps("addApprovalField", {
                      type: "checkbox",
                    })}
                  />
                  <Checkbox
                    label={t("signing.new.option.approval-mention")}
                    description={t("signing.new.option.approval-mention.desc")}
                    {...form.getInputProps("addApprovalMention", {
                      type: "checkbox",
                    })}
                  />
                  <Checkbox
                    label={t("signing.new.option.initials")}
                    description={t("signing.new.option.initials.desc")}
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
                            label: t(
                              "signing.new.option.initials.bottom-right",
                            ),
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
                  {teamKeyB64 && (
                    <Checkbox
                      label={t("signing.option.e2e-key-email")}
                      description={t("signing.option.e2e-key-email.desc")}
                      {...form.getInputProps("sendE2EKeyByEmail", {
                        type: "checkbox",
                      })}
                    />
                  )}
                  <Divider my="xs" />
                  <Checkbox
                    label={t("signing.new.option.custom-page")}
                    description={t("signing.new.option.custom-page.desc")}
                    {...form.getInputProps("customPageEnabled", {
                      type: "checkbox",
                    })}
                  />
                  {form.values.customPageEnabled && (
                    <>
                      <NumberInput
                        label={t(
                          "signing.new.option.custom-page.signature-label",
                        )}
                        description={t("signing.new.option.custom-page.hint")}
                        min={1}
                        max={9999}
                        style={{ maxWidth: 200 }}
                        {...form.getInputProps("signaturePage")}
                      />
                      {form.values.addApprovalField && (
                        <>
                          <Checkbox
                            label={t(
                              "signing.new.option.custom-page.watermark-same",
                            )}
                            {...form.getInputProps("watermarkSamePage", {
                              type: "checkbox",
                            })}
                          />
                          {!form.values.watermarkSamePage && (
                            <NumberInput
                              label={t(
                                "signing.new.option.custom-page.watermark-label",
                              )}
                              description={t(
                                "signing.new.option.custom-page.hint",
                              )}
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
              </Paper>

              {/* Recipients */}
              <Paper withBorder p="lg">
                <Stack gap="md">
                  <Group justify="space-between">
                    <Title order={4}>{t("signing.new.recipients")}</Title>
                    <Button
                      size="compact-sm"
                      variant="light"
                      leftSection={<TbPlus size={14} />}
                      onClick={addRecipient}
                    >
                      {t("signing.new.recipients.add")}
                    </Button>
                  </Group>

                  {form.values.recipients.map((_, idx) => (
                    <Paper
                      key={idx}
                      withBorder
                      p="sm"
                      bg="var(--mantine-color-default)"
                    >
                      <Stack gap="xs">
                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                          <TextInput
                            label={t("signing.detail.table.name")}
                            placeholder="Jean Dupont"
                            required
                            {...form.getInputProps(`recipients.${idx}.name`)}
                          />
                          <TextInput
                            label={t("signing.detail.table.email")}
                            placeholder="jean@example.com"
                            required
                            {...form.getInputProps(`recipients.${idx}.email`)}
                          />
                        </SimpleGrid>
                        <Group gap="xs" align="flex-end">
                          <Select
                            label={t("signing.detail.table.role")}
                            data={[
                              {
                                value: "SIGNER",
                                label: t("signing.role.signer"),
                              },
                              {
                                value: "APPROVER",
                                label: t("signing.role.approver"),
                              },
                              { value: "CC", label: t("signing.role.cc") },
                            ]}
                            style={{ flex: 1 }}
                            {...form.getInputProps(`recipients.${idx}.role`)}
                          />
                          <NumberInput
                            label={t("signing.new.recipients.order")}
                            min={1}
                            max={20}
                            style={{ width: 80 }}
                            {...form.getInputProps(`recipients.${idx}.order`)}
                          />
                          {form.values.recipients.length > 1 && (
                            <ActionIcon
                              color="red"
                              variant="subtle"
                              mt={22}
                              onClick={() => removeRecipient(idx)}
                            >
                              <TbTrash size={16} />
                            </ActionIcon>
                          )}
                        </Group>
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
              </Paper>

              {/* Signature fields */}
              <Paper withBorder p="lg">
                <Stack gap="md">
                  <Group justify="space-between">
                    <Title order={4}>{t("signing.new.fields")}</Title>
                    <Group gap="xs">
                      <Button
                        size="compact-sm"
                        variant="light"
                        leftSection={<TbPlus size={14} />}
                        onClick={() => addField("TEXT")}
                      >
                        {t("signing.new.fields.add-text")}
                      </Button>
                      <Button
                        size="compact-sm"
                        variant="light"
                        leftSection={<TbPlus size={14} />}
                        onClick={() => addField("APPROVAL")}
                      >
                        {t("signing.new.fields.add-approval")}
                      </Button>
                      <Button
                        size="compact-sm"
                        variant="light"
                        leftSection={<TbPlus size={14} />}
                        onClick={() => addField("SIGNATURE")}
                      >
                        {t("signing.new.fields.add-signature")}
                      </Button>
                    </Group>
                  </Group>

                  <Text size="xs" c="dimmed">
                    {t("signing.new.fields.desc")}
                  </Text>

                  {pdfLayoutLoading && (
                    <Group gap="xs">
                      <Loader size="xs" />
                      <Text size="sm" c="dimmed">
                        {t("signing.new.fields.preview.loading")}
                      </Text>
                    </Group>
                  )}
                  {pdfLayoutError && (
                    <Alert color="orange">
                      {t("signing.new.fields.preview.error")}
                    </Alert>
                  )}
                  {pageLayouts.length > 0 && (
                    <Paper withBorder p="sm">
                      <Stack gap="sm">
                        <Group justify="space-between" align="flex-end">
                          <div>
                            <Text size="sm" fw={600}>
                              {t("signing.new.fields.preview.title")}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {t("signing.new.fields.preview.dimensions", {
                                width: pageSizeMillimeters(
                                  getPageLayout(previewPage),
                                ).widthMm,
                                height: pageSizeMillimeters(
                                  getPageLayout(previewPage),
                                ).heightMm,
                              })}
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
                                minHeight: 430,
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
                              maxWidth: 360,
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

                  {form.values.fields.map((field, idx) => {
                    const textLike = ["TEXT", "APPROVAL"].includes(field.type);
                    return (
                      <Paper
                        key={idx}
                        withBorder
                        p="sm"
                        bg="var(--mantine-color-default)"
                      >
                        <Stack gap="xs">
                          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                            <Select
                              label={t("signing.new.fields.signer")}
                              data={form.values.recipients
                                .filter((r) => r.role === "SIGNER")
                                .map((r) => ({
                                  value: r.email,
                                  label: r.name || r.email,
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
              </Paper>

              <Divider />

              {/* Submit */}
              <Group justify="center">
                <Button variant="subtle" onClick={() => router.back()}>
                  {t("common.button.cancel")}
                </Button>
                <Button
                  type="submit"
                  size="md"
                  leftSection={<TbSend size={16} />}
                  loading={createMutation.isPending}
                >
                  {t("signing.new.submit")}
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </Container>
    </>
  );
};

export default NewSigningRequestPage;
