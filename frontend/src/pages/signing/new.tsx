import { useEffect, useMemo } from "react";
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
}

const NewSigningRequestPage = () => {
  const router = useRouter();
  const { user } = useUser();
  const t = useTranslate();

  useEffect(() => {
    if (user === null) {
      router.replace("/auth/signIn?redirect=/signing/new");
    } else if (user && user.plan !== "TEAM" && !user.isAdmin && !user.hasTeamMembership) {
      router.replace("/pricing");
    }
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

  const addField = () => {
    const firstRecipient = form.values.recipients[0]?.email || "";
    form.insertListItem("fields", {
      recipientEmail: firstRecipient,
      type: "SIGNATURE",
      page: 1,
      posX: 50,
      posY: 700,
      width: 200,
      height: 80,
      required: true,
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

    // Auto-add a signature field if none exists
    let fields = values.fields;
    if (fields.length === 0) {
      fields = values.recipients
        .filter((r) => r.role === "SIGNER")
        .map((r, idx) => ({
          recipientEmail: r.email,
          type: "SIGNATURE" as const,
          page: 1,
          posX: 50,
          posY: 650 - idx * 100,
          width: 200,
          height: 80,
          required: true,
        }));
    }

    createMutation.mutate({
      shareId,
      fileId,
      message: values.message || undefined,
      signatureLevel: values.signatureLevel,
      addApprovalField: values.addApprovalField,
      addApprovalMention: values.addApprovalMention,
      addInitials: values.addInitials,
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
      })),
    });
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
                  <Button
                    size="compact-sm"
                    variant="light"
                    leftSection={<TbPlus size={14} />}
                    onClick={addField}
                  >
                    {t("signing.new.fields.add")}
                  </Button>
                </Group>

                <Text size="xs" c="dimmed">
                  {t("signing.new.fields.desc")}
                </Text>

                {form.values.fields.map((_, idx) => (
                  <Paper key={idx} withBorder p="sm" bg="var(--mantine-color-default)">
                    <Group align="flex-end" wrap="wrap">
                      <Select
                        label={t("signing.new.fields.signer")}
                        data={form.values.recipients.map((r) => ({
                          value: r.email,
                          label: r.name || r.email,
                        }))}
                        style={{ width: 180 }}
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
                        style={{ width: 120 }}
                        {...form.getInputProps(`fields.${idx}.type`)}
                      />
                      <NumberInput
                        label="Page"
                        min={1}
                        style={{ width: 70 }}
                        {...form.getInputProps(`fields.${idx}.page`)}
                      />
                      <NumberInput
                        label="X"
                        min={0}
                        style={{ width: 70 }}
                        {...form.getInputProps(`fields.${idx}.posX`)}
                      />
                      <NumberInput
                        label="Y"
                        min={0}
                        style={{ width: 70 }}
                        {...form.getInputProps(`fields.${idx}.posY`)}
                      />
                      <ActionIcon
                        color="red"
                        variant="subtle"
                        onClick={() => form.removeListItem("fields", idx)}
                      >
                        <TbTrash size={16} />
                      </ActionIcon>
                    </Group>
                  </Paper>
                ))}
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
