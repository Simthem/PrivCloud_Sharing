import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Container,
  Group,
  Loader,
  Menu,
  Paper,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  TbBell,
  TbDotsVertical,
  TbDownload,
  TbFileDescription,
  TbInbox,
  TbPlus,
  TbShieldCheck,
  TbX,
  TbFileOff,
} from "react-icons/tb";
import { useRouter } from "next/router";
import { useIntl } from "react-intl";
import Meta from "../../components/Meta";
import signingService, { SignatureRequest } from "../../services/signing.service";
import toast from "../../utils/toast.util";
import useUser from "../../hooks/user.hook";
import useTranslate from "../../hooks/useTranslate.hook";

const statusColors: Record<string, string> = {
  PENDING: "yellow",
  PARTIAL: "blue",
  COMPLETED: "green",
  CANCELLED: "gray",
  REJECTED: "red",
  AWAITING_FINALIZATION: "orange",
};

const statusKeyMap: Record<string, string> = {
  PENDING: "signing.status.pending",
  PARTIAL: "signing.status.partial",
  COMPLETED: "signing.status.completed",
  CANCELLED: "signing.status.cancelled",
  REJECTED: "signing.status.rejected",
  AWAITING_FINALIZATION: "signing.status.awaiting-finalization",
};

const SigningIndexPage = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useUser();
  const isMobile = useMediaQuery("(max-width: 680px)");
  const t = useTranslate();
  const intl = useIntl();

  useEffect(() => {
    if (user === null) {
      router.replace("/auth/signIn?redirect=/signing");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const { data: documents, isLoading } = useQuery({
    queryKey: ["signing.documents"],
    queryFn: () => signingService.getMyDocuments(),
    enabled: !!user,
  });

  const { data: receivedDocs, isLoading: isLoadingReceived } = useQuery({
    queryKey: ["signing.received"],
    queryFn: () => signingService.getReceivedDocuments(),
    enabled: !!user,
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => signingService.cancelDocument(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["signing.documents"] });
      toast.success(t("signing.toast.cancelled"));
    },
    onError: () => toast.error(t("signing.toast.cancel-error")),
  });

  const reminderMutation = useMutation({
    mutationFn: (id: string) => signingService.sendReminder(id),
    onSuccess: () => toast.success(t("signing.toast.reminder-sent")),
    onError: () => toast.error(t("signing.toast.reminder-error")),
  });

  const handleDownload = async (doc: SignatureRequest) => {
    if (doc.isE2EEncrypted) {
      router.push(`/signing/${doc.id}`);
      return;
    }
    try {
      const blob = await signingService.downloadSigned(doc.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${doc.title || doc.fileName || "document"}_signe.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t("signing.toast.download-error"));
    }
  };

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString(intl.locale, { timeZone: "Europe/Paris" });

  const getStatusLabel = (status: string) =>
    statusKeyMap[status] ? t(statusKeyMap[status]) : status;

  const getRoleLabel = (role?: string) => {
    if (role === "SIGNER") return t("signing.role.signer");
    if (role === "APPROVER") return t("signing.role.approver");
    if (role === "CC") return t("signing.role.cc");
    return "-";
  };

  if (!user) {
    return (
      <Box ta="center" py="xl">
        <Loader />
      </Box>
    );
  }

  return (
    <>
      <Meta title={t("signing.title")} />
      <Container size="lg" mt="xl" px={0}>
        <Group justify="space-between" mb="lg">
          <Title order={2}>
            <Group gap="xs">
              <TbFileDescription size={28} />
              {t("signing.my-signatures")}
            </Group>
          </Title>
          <Button
            leftSection={<TbPlus size={16} />}
            onClick={() => router.push("/signing/new")}
          >
            {t("signing.new")}
          </Button>
        </Group>

        {isLoading && (
          <Box ta="center" py="xl">
            <Loader />
          </Box>
        )}

        {!isLoading && (!documents || documents.length === 0) && (
          <Paper withBorder p="xl" ta="center">
            <Stack align="center" gap="md">
              <TbShieldCheck size={48} color="gray" />
              <Text c="dimmed">
                {t("signing.empty.eidas")}
              </Text>
              <Button
                leftSection={<TbPlus size={16} />}
                onClick={() => router.push("/signing/new")}
              >
                {t("signing.empty.create")}
              </Button>
            </Stack>
          </Paper>
        )}

        {documents && documents.length > 0 && (
          isMobile ? (
            <Stack gap="sm">
              {documents.map((doc) => (
                <Card key={doc.id} withBorder padding="sm" style={{ cursor: "pointer" }} onClick={() => router.push(`/signing/${doc.id}`)}>
                  <Group justify="space-between" mb={4}>
                    <Text fw={600} size="sm" lineClamp={1} style={{ flex: 1 }}>
                      {doc.fileName || doc.title || t("signing.no-title")}
                    </Text>
                    <Badge color={statusColors[doc.status] || "gray"} variant="light" size="sm">
                      {getStatusLabel(doc.status)}
                    </Badge>
                  </Group>
                  <Group gap={4} mb={4}>
                    <Badge color="blue" variant="light" size="xs">{doc.signatureLevel}</Badge>
                    {(doc as any).fileDeleted && (
                      <Tooltip label={t("signing.file-deleted")}>
                        <Badge color="red" variant="light" size="xs" leftSection={<TbFileOff size={10} />}>
                          {t("signing.file-deleted.badge")}
                        </Badge>
                      </Tooltip>
                    )}
                    <Text size="xs" c="dimmed">
                      {formatDate(doc.createdAt)}
                    </Text>
                  </Group>
                  <Stack gap={2}>
                    {doc.recipients?.map((r) => (
                      <Tooltip key={r.id} label={`${r.name} - ${r.email}`} multiline maw={250}>
                        <Badge
                          size="xs"
                          color={r.status === "SIGNED" ? "green" : r.status === "REJECTED" ? "red" : "gray"}
                          variant="dot"
                          style={{ maxWidth: "100%" }}
                        >
                          <Text size="xs" truncate style={{ maxWidth: 140 }}>{r.name}</Text>
                        </Badge>
                      </Tooltip>
                    ))}
                  </Stack>
                  <Group gap={4} mt="xs" onClick={(e) => e.stopPropagation()}>
                    {doc.status === "COMPLETED" && !(doc as any).fileDeleted && (
                      <Button size="compact-xs" variant="light" color="green" onClick={() => handleDownload(doc)}>
                        {t("signing.actions.download")}
                      </Button>
                    )}
                    {(doc.status === "PENDING" || doc.status === "PARTIAL") && (
                      <Button size="compact-xs" variant="light" onClick={() => reminderMutation.mutate(doc.id)}>
                        {t("signing.actions.remind")}
                      </Button>
                    )}
                  </Group>
                </Card>
              ))}
            </Stack>
          ) : (
          <Paper withBorder>
            <Table striped highlightOnHover style={{ tableLayout: "fixed" }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("signing.document")}</Table.Th>
                  <Table.Th style={{ width: 80 }}>{t("signing.level")}</Table.Th>
                  <Table.Th style={{ width: 180 }}>{t("signing.recipients")}</Table.Th>
                  <Table.Th style={{ width: 165 }}>{t("signing.status")}</Table.Th>
                  <Table.Th style={{ width: 100 }}>{t("signing.date")}</Table.Th>
                  <Table.Th style={{ width: 80 }}>{t("signing.actions")}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {documents.map((doc) => (
                  <Table.Tr
                    key={doc.id}
                    style={{ cursor: "pointer" }}
                    onClick={() => router.push(`/signing/${doc.id}`)}
                  >
                    <Table.Td style={{ overflow: "hidden" }}>
                      <Group gap={6} wrap="nowrap">
                        <Text fw={500} truncate style={{ flex: 1 }}>
                          {doc.fileName || doc.title || t("signing.no-title")}
                        </Text>
                        {(doc as any).fileDeleted && (
                          <Tooltip label={t("signing.file-deleted")}>
                            <Badge color="red" variant="light" size="xs" leftSection={<TbFileOff size={10} />}>
                              {t("signing.file-deleted.badge")}
                            </Badge>
                          </Tooltip>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        color={doc.signatureLevel === "QES" ? "violet" : "blue"}
                        variant="light"
                        size="sm"
                      >
                        {doc.signatureLevel}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={2}>
                        {doc.recipients?.map((r) => (
                          <Tooltip key={r.id} label={`${r.name} - ${r.email}`} multiline maw={300}>
                            <Badge
                              size="sm"
                              color={
                                r.status === "SIGNED"
                                  ? "green"
                                  : r.status === "REJECTED"
                                    ? "red"
                                    : "gray"
                              }
                              variant="dot"
                              style={{ maxWidth: "100%" }}
                            >
                              <Text size="xs" truncate style={{ maxWidth: 150 }}>{r.name}</Text>
                            </Badge>
                          </Tooltip>
                        ))}
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        color={statusColors[doc.status] || "gray"}
                        variant="light"
                      >
                        {getStatusLabel(doc.status)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {formatDate(doc.createdAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                        <Tooltip label={t("signing.actions.view")}>
                          <ActionIcon
                            variant="light"
                            color="blue"
                            size="sm"
                            onClick={() => router.push(`/signing/${doc.id}`)}
                          >
                            <TbFileDescription size={14} />
                          </ActionIcon>
                        </Tooltip>
                        {doc.status === "AWAITING_FINALIZATION" && (
                          <Tooltip label={t("signing.actions.finalize-e2e")}>
                            <ActionIcon
                              variant="filled"
                              color="orange"
                              size="sm"
                              onClick={() => router.push(`/signing/${doc.id}`)}
                            >
                              <TbShieldCheck size={14} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                        <Menu position="bottom-end">
                          <Menu.Target>
                            <ActionIcon variant="subtle" color="gray">
                              <TbDotsVertical size={16} />
                            </ActionIcon>
                          </Menu.Target>
                        <Menu.Dropdown>
                          {doc.status === "COMPLETED" && !(doc as any).fileDeleted && (
                            <Menu.Item
                              leftSection={<TbDownload size={14} />}
                              onClick={() => handleDownload(doc)}
                            >
                              {t("signing.actions.download")}
                            </Menu.Item>
                          )}
                          {(doc.status === "PENDING" ||
                            doc.status === "PARTIAL") && (
                            <>
                              <Menu.Item
                                leftSection={<TbBell size={14} />}
                                onClick={() => reminderMutation.mutate(doc.id)}
                              >
                                {t("signing.actions.remind")}
                              </Menu.Item>
                              <Menu.Item
                                leftSection={<TbX size={14} />}
                                color="red"
                                onClick={() => cancelMutation.mutate(doc.id)}
                              >
                                {t("signing.actions.cancel")}
                              </Menu.Item>
                            </>
                          )}
                          <Menu.Item
                            leftSection={<TbFileDescription size={14} />}
                            onClick={() =>
                              router.push(`/signing/${doc.id}`)
                            }
                          >
                            {t("signing.actions.audit")}
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
          )
        )}

        {/* ============= Received documents ============= */}
        <Title order={3} mt="xl" mb="md">
          <Group gap="xs">
            <TbInbox size={24} />
            {t("signing.received")}
          </Group>
        </Title>

        {isLoadingReceived && (
          <Box ta="center" py="xl">
            <Loader />
          </Box>
        )}

        {!isLoadingReceived && (!receivedDocs || receivedDocs.length === 0) && (
          <Paper withBorder p="lg" ta="center">
            <Text c="dimmed" size="sm">
              {t("signing.received.empty")}
            </Text>
          </Paper>
        )}

        {receivedDocs && receivedDocs.length > 0 && (
          isMobile ? (
            <Stack gap="sm">
              {receivedDocs.map((doc) => {
                const creator = (doc as any).creator;
                const myRecipient = doc.recipients?.find(
                  (r) => r.status === "SIGNED" || r.status === "PENDING" || r.status === "VIEWED"
                );
                return (
                  <Card key={doc.id} withBorder padding="sm" style={{ cursor: "pointer" }} onClick={() => router.push(`/signing/${doc.id}`)}>
                    <Group justify="space-between" mb={4}>
                      <Text fw={600} size="sm" lineClamp={1} style={{ flex: 1 }}>
                        {doc.fileName || doc.title || t("signing.no-title")}
                      </Text>
                      <Badge color={statusColors[doc.status] || "gray"} variant="light" size="sm">
                        {getStatusLabel(doc.status)}
                      </Badge>
                    </Group>
                    <Group gap="xs" mb={4}>
                      <Text size="xs" c="dimmed">{t("signing.sent-by")} : {creator?.username || creator?.email || "-"}</Text>
                      <Badge size="xs" variant="light" color="blue">
                        {getRoleLabel(myRecipient?.role)}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed">
                      {formatDate(doc.createdAt)}
                    </Text>
                    {doc.status === "COMPLETED" && (
                      <Group mt="xs" onClick={(e) => e.stopPropagation()}>
                        <Button size="compact-xs" variant="light" color="green" onClick={() => handleDownload(doc)}>
                          {t("signing.actions.download")}
                        </Button>
                      </Group>
                    )}
                  </Card>
                );
              })}
            </Stack>
          ) : (
          <Paper withBorder>
            <Table striped highlightOnHover style={{ tableLayout: "fixed" }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("signing.document")}</Table.Th>
                  <Table.Th style={{ width: 140 }}>{t("signing.sent-by")}</Table.Th>
                  <Table.Th style={{ width: 100 }}>{t("signing.my-role")}</Table.Th>
                  <Table.Th style={{ width: 165 }}>{t("signing.status")}</Table.Th>
                  <Table.Th style={{ width: 100 }}>{t("signing.date")}</Table.Th>
                  <Table.Th style={{ width: 80 }}>{t("signing.actions")}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {receivedDocs.map((doc) => {
                  const creator = (doc as any).creator;
                  const myRecipient = doc.recipients?.find(
                    (r) => r.status === "SIGNED" || r.status === "PENDING" || r.status === "VIEWED"
                  );
                  return (
                    <Table.Tr
                      key={doc.id}
                      style={{ cursor: "pointer" }}
                      onClick={() => router.push(`/signing/${doc.id}`)}
                    >
                      <Table.Td style={{ overflow: "hidden" }}>
                        <Text fw={500} truncate>
                          {doc.fileName || doc.title || t("signing.no-title")}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {creator?.username || creator?.email || "-"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge size="xs" variant="light" color="blue">
                          {getRoleLabel(myRecipient?.role)}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={statusColors[doc.status] || "gray"}
                          variant="light"
                        >
                          {getStatusLabel(doc.status)}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {formatDate(doc.createdAt)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                          <Tooltip label={t("signing.actions.view")}>
                            <ActionIcon
                              variant="light"
                              color="blue"
                              size="sm"
                              onClick={() => router.push(`/signing/${doc.id}`)}
                            >
                              <TbFileDescription size={14} />
                            </ActionIcon>
                          </Tooltip>
                          {doc.status === "COMPLETED" && (
                            <Tooltip label={t("signing.actions.download")}>
                              <ActionIcon
                                variant="light"
                                color="green"
                                size="sm"
                                onClick={() => handleDownload(doc)}
                              >
                                <TbDownload size={14} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Paper>
          )
        )}
      </Container>
    </>
  );
};

export default SigningIndexPage;
