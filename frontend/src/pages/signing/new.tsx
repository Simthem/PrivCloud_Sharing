import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/router";
import {
  ActionIcon,
  Button,
  Checkbox,
  Container,
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
import { TbPlus, TbTrash, TbShieldCheck, TbSend } from "react-icons/tb";
import Meta from "../../components/Meta";
import useUser from "../../hooks/user.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import signingService, {
  CreateSignatureRequestPayload,
} from "../../services/signing.service";
import teamService from "../../services/team.service";
import toast from "../../utils/toast.util";
import {
  getUserKey,
  importKeyFromBase64,
  exportKeyToBase64,
  unwrapReverseShareKey,
} from "../../utils/crypto.util";

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

const NewSigningRequestPage = () => {
  const router = useRouter();
  const { user } = useUser();
  const t = useTranslate();
  const [teamKeyB64, setTeamKeyB64] = useState<string | null>(null);

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
      signatureLevel: "AES" as "AES",
      addApprovalField: true,
      addApprovalMention: true,
      addInitials: false,
      sendE2EKeyByEmail: false,
      selectedFile: "" as string,
      shareId: "",
      fileId: "",
      recipients: [{ name: "", email: "", role: "SIGNER" as const, order: 1 }] as RecipientForm[],
      fields: [] as FieldForm[],
    },
    validate: {
      selectedFile: (val: string) => (!val ? t("signing.new.validate.file-required") : null),
      recipients: {
        name: (val: string) => (!val ? t("signing.new.validate.name-required") : null),
        email: (val: string) =>
          !val || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)
            ? t("signing.new.validate.email-invalid")
            : null,
      },
    },
  });

  const selectedFileValue = form.values.selectedFile;
  useEffect(() => {
    if (!selectedFileValue || !signableFiles) {
      setTeamKeyB64(null);
      return;
    }
    const [shareId] = selectedFileValue.split("::");
    const fileEntry = signableFiles.find((f) => f.shareId === shareId);
    if (!fileEntry) {
      setTeamKeyB64(null);
      return;
    }
    setTeamKeyB64(null);

    let cancelled = false;
    (async () => {
      try {
        const userKeyB64 = getUserKey();
        if (!userKeyB64) return;
        const { wrappedTeamKey } = await teamService.getTeamKey(fileEntry.teamId);
        if (cancelled || !wrappedTeamKey) return;
        const masterKey = await importKeyFromBase64(userKeyB64);
        const teamKey = await unwrapReverseShareKey(wrappedTeamKey, masterKey);
        const keyB64 = await exportKeyToBase64(teamKey);
        if (!cancelled) setTeamKeyB64(keyB64);
      } catch {
        const userKeyB64 = getUserKey();
        if (!cancelled && userKeyB64) setTeamKeyB64(userKeyB64);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedFileValue, signableFiles]);

  const createMutation = useMutation({
    mutationFn: (data: CreateSignatureRequestPayload) =>
      signingService.createRequest(data),
    onSuccess: (result: any) => {
      toast.success(t("signing.toast.created"));
      // Navigate to detail page where signing links are visible
      if (result?.id) {
        router.push(`/signing/${result.id}`);
      } else {
        router.push("/signing");
      }
    },
    onError: () => toast.error(t("signing.toast.create-error")),
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

  const addField = (type: FieldForm["type"] = "SIGNATURE") => {
    const firstRecipient =
      form.values.recipients.find((r) => r.role === "SIGNER")?.email || "";
    const textLike = ["TEXT", "APPROVAL"].includes(type);
    const width = textLike ? TEXT_FIELD_WIDTH : SIGNATURE_FIELD_WIDTH;
    const height = textLike ? TEXT_FIELD_HEIGHT : SIGNATURE_FIELD_HEIGHT;
    const bottomRight = getPlacementCoordinates("bottom-right", width, height);
    form.insertListItem("fields", {
      recipientEmail: firstRecipient,
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

    const fileEntry = signableFiles?.find((f) => f.shareId === shareId && f.fileId === fileId);
    const shouldEmailE2EKey = Boolean(teamKeyB64 && values.sendE2EKeyByEmail);

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

    createMutation.mutate({
      shareId,
      fileId,
      message: values.message || undefined,
      signatureLevel: values.signatureLevel,
      addApprovalField: values.addApprovalField,
      addApprovalMention: values.addApprovalMention,
      addInitials: values.addInitials,
      isE2EEncrypted: !!teamKeyB64,
      sendE2EKeyByEmail: shouldEmailE2EKey,
      e2eKey: shouldEmailE2EKey ? teamKeyB64 || undefined : undefined,
      teamId: fileEntry?.teamId || undefined,
      recipients: values.recipients.map((r) => ({
        name: r.name,
        email: r.email,
        role: r.role,
        order: r.order,
      })),
      fields: fields.map((f) => ({
        assignedRecipientEmail: f.recipientEmail,
        type: f.type,
        page: f.page,
        posX: f.posX,
        posY: f.posY,
        width: f.width,
        height: f.height,
        required: f.required,
        label: f.label || undefined,
      })),
    });
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

  return (
    <>
      <Meta title={t("signing.new.title")} />
      <Container size="md" mt="xl" mb="xl" px={0}>
        <Group gap="xs" mb="lg" align="center" wrap="nowrap">
          <TbShieldCheck size={26} />
          <Title order={2}>{t("signing.new.title")}</Title>
        </Group>

        <form onSubmit={form.onSubmit(handleSubmit)}>
          <Stack gap="lg">
            {/* Document info */}
            <Paper withBorder p="lg">
              <Stack gap="md">
                <Title order={4}>{t("signing.document")}</Title>
                {filesLoading ? (
                  <Group gap="xs">
                    <Loader size="xs" />
                    <Text size="sm" c="dimmed">{t("signing.new.loading-files")}</Text>
                  </Group>
                ) : fileSelectData.length === 0 ? (
                  <Text size="sm" c="dimmed">{t("signing.new.no-signable-files")}</Text>
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
              </Stack>
            </Paper>

            {/* Signing options */}
            <Paper withBorder p="lg">
              <Stack gap="md">
                <Title order={4}>{t("signing.new.options")}</Title>
                <Checkbox
                  label={t("signing.new.option.approval-field")}
                  description={t("signing.new.option.approval-field.desc")}
                  {...form.getInputProps("addApprovalField", { type: "checkbox" })}
                />
                <Checkbox
                  label={t("signing.new.option.approval-mention")}
                  description={t("signing.new.option.approval-mention.desc")}
                  {...form.getInputProps("addApprovalMention", { type: "checkbox" })}
                />
                <Checkbox
                  label={t("signing.new.option.initials")}
                  description={t("signing.new.option.initials.desc")}
                  {...form.getInputProps("addInitials", { type: "checkbox" })}
                />
                {teamKeyB64 && (
                  <Checkbox
                    label={t("signing.option.e2e-key-email")}
                    description={t("signing.option.e2e-key-email.desc")}
                    {...form.getInputProps("sendE2EKeyByEmail", { type: "checkbox" })}
                  />
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
                  <Paper key={idx} withBorder p="sm" bg="var(--mantine-color-default)">
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
                            { value: "SIGNER", label: t("signing.role.signer") },
                            { value: "APPROVER", label: t("signing.role.approver") },
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

                {form.values.fields.map((field, idx) => {
                  const textLike = ["TEXT", "APPROVAL"].includes(field.type);
                  return (
                  <Paper key={idx} withBorder p="sm" bg="var(--mantine-color-default)">
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
      </Container>
    </>
  );
};

export default NewSigningRequestPage;
