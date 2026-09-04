import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import "@mantine/core/styles/SegmentedControl.css";
import "@mantine/core/styles/Switch.css";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Loader,
  Modal,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
  Box,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  TbAlertTriangle,
  TbArrowLeft,
  TbBell,
  TbDeviceFloppy,
  TbFolder,
  TbShieldCheck,
  TbTrash,
  TbUser,
  TbUserMinus,
  TbUsers,
  TbKey,
  TbReportAnalytics,
  TbSend,
} from "react-icons/tb";
import Meta from "../../../components/Meta";
import teamService from "../../../services/team.service";
import useUser from "../../../hooks/user.hook";
import useTranslate from "../../../hooks/useTranslate.hook";
import toast from "../../../utils/toast.util";

const TeamSettings = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id: teamId } = router.query;
  const teamIdStr = Array.isArray(teamId) ? teamId[0] : teamId || "";
  const user = useUser();
  const t = useTranslate();
  const isMobile = useMediaQuery("(max-width: 680px)");

  const { data: team, isLoading } = useQuery({
    queryKey: ["team", teamIdStr],
    queryFn: () => teamService.getTeam(teamIdStr),
    enabled: !!teamIdStr,
  });

  // Determine current user role
  const myRole = useMemo(() => {
    if (!team?.members || !user.user) return null;
    const me = team.members.find((m: any) => m.user?.id === user.user!.id);
    return me?.role ?? null;
  }, [team, user.user]);
  const isTeamAdmin = myRole === "OWNER" || myRole === "ADMIN";

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [reportEnabled, setReportEnabled] = useState(true);
  const [reportFrequency, setReportFrequency] = useState("WEEKLY");
  const [keyRotationIntervalDays, setKeyRotationIntervalDays] = useState("90");
  const [pqNotificationEncryptionEnabled, setPqNotificationEncryptionEnabled] =
    useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [selectedMember, setSelectedMember] = useState<any>(null);
  const [memberModalOpen, setMemberModalOpen] = useState(false);
  const [removeMemberConfirm, setRemoveMemberConfirm] = useState(false);

  // Fetch folder access for selected member
  const { data: memberAccess, isLoading: memberAccessLoading } = useQuery({
    queryKey: ["team.memberAccess", teamIdStr, selectedMember?.id],
    queryFn: () =>
      teamService.getMemberFolderAccess(teamIdStr, selectedMember?.id),
    enabled: !!teamIdStr && !!selectedMember?.id && memberModalOpen,
  });

  useEffect(() => {
    if (team) {
      setName(team.name || "");
      setDescription(team.description || "");
      setReportEnabled(team.reportEnabled ?? true);
      setReportFrequency(team.reportFrequency || "WEEKLY");
      setKeyRotationIntervalDays(String(team.keyRotationIntervalDays || 90));
      setPqNotificationEncryptionEnabled(
        team.pqNotificationEncryptionEnabled ?? false,
      );
    }
  }, [team]);

  const updateMutation = useMutation({
    mutationFn: () =>
      teamService.updateTeam(teamIdStr, {
        name,
        description,
        reportEnabled,
        reportFrequency,
        keyRotationIntervalDays: Number(keyRotationIntervalDays),
      }),
    onSuccess: () => {
      toast.success(t("team.settings.toast.updated"));
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message || t("team.settings.toast.updateError"),
      ),
  });

  const deleteMutation = useMutation({
    mutationFn: (confirmationName: string) =>
      teamService.deleteTeam(teamIdStr, confirmationName),
    onSuccess: () => {
      toast.success(t("team.settings.toast.deleted"));
      router.push("/account");
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message || t("team.settings.toast.deleteError"),
      ),
  });

  const pqNotificationEncryptionMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      teamService.updateTeam(teamIdStr, {
        pqNotificationEncryptionEnabled: enabled,
      }),
    onSuccess: () => {
      toast.success(t("team.settings.toast.pqNotificationUpdated"));
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
    },
    onError: (err: any) => {
      setPqNotificationEncryptionEnabled(
        team?.pqNotificationEncryptionEnabled ?? false,
      );
      toast.error(
        err?.response?.data?.message || t("team.settings.toast.error"),
      );
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (memberId: string) =>
      teamService.removeMember(teamIdStr, memberId),
    onSuccess: () => {
      toast.success(t("team.settings.toast.memberRemoved"));
      setMemberModalOpen(false);
      setSelectedMember(null);
      setRemoveMemberConfirm(false);
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message || t("team.settings.toast.error"),
      ),
  });

  const setFolderAccessMutation = useMutation({
    mutationFn: ({
      folderId,
      permission,
    }: {
      folderId: string;
      permission: string;
    }) =>
      teamService.setFolderAccess(teamIdStr, folderId, {
        memberId: selectedMember?.id,
        permission,
      }),
    onSuccess: (_data, { folderId, permission }) => {
      updateMemberAccessCache(folderId, permission);
      queryClient.invalidateQueries({
        queryKey: ["team.memberAccess", teamIdStr, selectedMember?.id],
      });
      toast.success(t("team.settings.toast.permissionUpdated"));
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message || t("team.settings.toast.error"),
      ),
  });

  const removeFolderAccessMutation = useMutation({
    mutationFn: (folderId: string) =>
      teamService.removeFolderAccess(teamIdStr, folderId, selectedMember?.id),
    onSuccess: (_data, folderId) => {
      updateMemberAccessCache(folderId, null);
      queryClient.invalidateQueries({
        queryKey: ["team.memberAccess", teamIdStr, selectedMember?.id],
      });
      toast.success(t("team.settings.toast.accessRuleRemoved"));
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message || t("team.settings.toast.error"),
      ),
  });

  const leaveTeamMutation = useMutation({
    mutationFn: () => teamService.leaveTeam(teamIdStr),
    onSuccess: () => {
      toast.success(t("team.settings.toast.leftTeam"));
      router.push("/account");
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message || t("team.settings.toast.leaveError"),
      ),
  });

  // Push notification preference (self-service)
  const myMembership = useMemo(() => {
    if (!team?.members || !user.user) return null;
    return team.members.find((m: any) => m.user?.id === user.user!.id) ?? null;
  }, [team, user.user]);

  const [pushNotifMode, setPushNotifMode] = useState<string>("EVERY_FILE");
  useEffect(() => {
    if (myMembership?.pushNotifMode) {
      setPushNotifMode(myMembership.pushNotifMode);
    }
  }, [myMembership]);

  const pushPrefMutation = useMutation({
    mutationFn: (mode: string) =>
      teamService.updateMyPreferences(teamIdStr, { pushNotifMode: mode }),
    onSuccess: () => {
      toast.success(t("team.settings.toast.notifPrefUpdated"));
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message || t("team.settings.toast.error"),
      ),
  });

  const { data: auditReports } = useQuery({
    queryKey: ["team.auditReports", teamIdStr],
    queryFn: () => teamService.getAuditReports(teamIdStr),
    enabled: !!teamIdStr && isTeamAdmin,
  });

  const sendAuditMutation = useMutation({
    mutationFn: () => teamService.sendAuditReportNow(teamIdStr),
    onSuccess: () => {
      toast.success(t("team.settings.audit.sent"));
      queryClient.invalidateQueries({
        queryKey: ["team.auditReports", teamIdStr],
      });
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message || t("team.settings.audit.sendError"),
      ),
  });

  if (isLoading || !teamIdStr) {
    return (
      <Container size="sm" mt="xl" px={0}>
        <Box ta="center" py="xl">
          <Loader size="lg" />
        </Box>
      </Container>
    );
  }

  if (!team) {
    return (
      <Container size="sm" mt="xl" px={0}>
        <Alert color="red">{t("team.settings.notFound")}</Alert>
      </Container>
    );
  }

  if (!isTeamAdmin && myRole !== "MEMBER") {
    return (
      <Container size="sm" mt="xl" px={0}>
        <Alert color="orange">{t("team.settings.noPermission")}</Alert>
      </Container>
    );
  }

  const permissionOptions = [
    { value: "NONE", label: t("team.settings.perm.none") },
    { value: "READ", label: t("team.settings.perm.read") },
    { value: "WRITE", label: t("team.settings.perm.write") },
    { value: "ADMIN", label: t("team.settings.perm.admin") },
  ];

  const permissionBadge = (perm: string | null) => {
    if (!perm)
      return (
        <Badge size="sm" variant="light" color="gray">
          {t("team.settings.perm.badge.default")}
        </Badge>
      );
    const map: Record<string, { color: string; label: string }> = {
      NONE: { color: "red", label: t("team.settings.perm.badge.denied") },
      READ: { color: "blue", label: t("team.settings.perm.badge.read") },
      WRITE: { color: "green", label: t("team.settings.perm.badge.write") },
      ADMIN: { color: "violet", label: t("team.settings.perm.badge.admin") },
    };
    const v = map[perm] || { color: "gray", label: perm };
    return (
      <Badge size="sm" variant="filled" color={v.color}>
        {v.label}
      </Badge>
    );
  };

  const updateMemberAccessCache = (
    folderId: string,
    permission: string | null,
  ) => {
    queryClient.setQueryData<
      | {
          member: any;
          folders: {
            id: string;
            name: string;
            color: string | null;
            permission: string | null;
          }[];
        }
      | undefined
    >(["team.memberAccess", teamIdStr, selectedMember?.id], (current) =>
      current
        ? {
            ...current,
            folders: current.folders.map((folder) =>
              folder.id === folderId ? { ...folder, permission } : folder,
            ),
          }
        : current,
    );
  };

  return (
    <>
      <Meta title={t("team.settings.metaTitle", { name: team.name })} />
      <Container size="sm" mt="xl" mb="xl" px={0}>
        <Group mb="lg">
          <Button
            variant="subtle"
            leftSection={<TbArrowLeft size={16} />}
            onClick={() => router.push(`/team/${teamIdStr}`)}
          >
            {t("team.settings.back")}
          </Button>
        </Group>

        <Title order={2} mb="lg">
          {t("team.settings.title")}
        </Title>

        <Paper withBorder p="lg" mb="lg">
          <Stack>
            <TextInput
              label={t("team.settings.info.name")}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              maxLength={50}
              required
            />
            <Textarea
              label={t("team.settings.info.description")}
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              maxLength={200}
              autosize
              minRows={2}
            />
            <Group justify="flex-end">
              <Button
                leftSection={<TbDeviceFloppy size={16} />}
                onClick={() => updateMutation.mutate()}
                loading={updateMutation.isPending}
                disabled={!name.trim()}
              >
                {t("team.settings.info.save")}
              </Button>
            </Group>
          </Stack>
        </Paper>

        {isTeamAdmin && (
          <>
            <Divider my="lg" />
            <Paper withBorder p="lg" mb="lg">
              <Group mb="md">
                <TbReportAnalytics size={20} />
                <Title order={4}>{t("team.settings.audit.title")}</Title>
              </Group>
              <Stack gap="md">
                <Switch
                  checked={reportEnabled}
                  onChange={(event) =>
                    setReportEnabled(event.currentTarget.checked)
                  }
                  label={t("team.settings.audit.enabled")}
                />
                <SegmentedControl
                  value={reportFrequency}
                  onChange={setReportFrequency}
                  disabled={!reportEnabled}
                  data={[
                    { value: "WEEKLY", label: t("team.settings.audit.weekly") },
                    {
                      value: "MONTHLY",
                      label: t("team.settings.audit.monthly"),
                    },
                  ]}
                  fullWidth
                />
                <Group justify="space-between" align="flex-end" wrap="wrap">
                  <Text size="xs" c="dimmed">
                    {t("team.settings.audit.recipients")}
                  </Text>
                  <Button
                    size="compact-sm"
                    variant="light"
                    leftSection={<TbSend size={14} />}
                    loading={sendAuditMutation.isPending}
                    onClick={() => sendAuditMutation.mutate()}
                  >
                    {t("team.settings.audit.sendNow")}
                  </Button>
                </Group>
                {auditReports && auditReports.length > 0 && (
                  <Stack gap="xs">
                    <Text size="sm" fw={600}>
                      {t("team.settings.audit.history")}
                    </Text>
                    {auditReports.slice(0, 5).map((report) => (
                      <Group
                        key={report.id}
                        justify="space-between"
                        wrap="nowrap"
                      >
                        <Box style={{ minWidth: 0 }}>
                          <Text size="sm" truncate>
                            {new Date(report.periodStart).toLocaleDateString()}{" "}
                            - {new Date(report.periodEnd).toLocaleDateString()}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {report.summary?.totals.events || 0}{" "}
                            {t("team.settings.audit.events")}
                          </Text>
                        </Box>
                        <Badge
                          size="sm"
                          color={
                            report.status === "SENT"
                              ? "green"
                              : report.status === "FAILED"
                                ? "red"
                                : "yellow"
                          }
                          variant="light"
                        >
                          {t(
                            `team.settings.audit.status.${report.status.toLowerCase()}`,
                          )}
                        </Badge>
                      </Group>
                    ))}
                  </Stack>
                )}
              </Stack>
            </Paper>

            <Paper withBorder p="lg" mb="lg">
              <Group mb="md">
                <TbKey size={20} />
                <Title order={4}>{t("team.settings.rotation.title")}</Title>
              </Group>
              <Select
                label={t("team.settings.rotation.interval")}
                value={keyRotationIntervalDays}
                onChange={(value) => value && setKeyRotationIntervalDays(value)}
                data={[
                  {
                    value: "30",
                    label: t("team.settings.rotation.days", { count: 30 }),
                  },
                  {
                    value: "60",
                    label: t("team.settings.rotation.days", { count: 60 }),
                  },
                  {
                    value: "90",
                    label: t("team.settings.rotation.days", { count: 90 }),
                  },
                  {
                    value: "180",
                    label: t("team.settings.rotation.days", { count: 180 }),
                  },
                  {
                    value: "365",
                    label: t("team.settings.rotation.days", { count: 365 }),
                  },
                ]}
              />
            </Paper>

            <Paper withBorder p="lg" mb="lg">
              <Group mb="md">
                <TbShieldCheck size={20} />
                <Title order={4}>
                  {t("team.settings.pqNotifications.title")}
                </Title>
              </Group>
              <Stack gap="xs">
                <Switch
                  checked={pqNotificationEncryptionEnabled}
                  disabled={pqNotificationEncryptionMutation.isPending}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked;
                    setPqNotificationEncryptionEnabled(enabled);
                    pqNotificationEncryptionMutation.mutate(enabled);
                  }}
                  label={t("team.settings.pqNotifications.enabled")}
                />
                <Text size="xs" c="dimmed">
                  {t("team.settings.pqNotifications.help")}
                </Text>
              </Stack>
            </Paper>
          </>
        )}

        {/* ----- Section membres (admins uniquement) ----- */}
        {isTeamAdmin && (
          <>
            <Divider my="lg" />
            <Paper withBorder p="lg" mb="lg">
              <Group mb="md">
                <TbUsers size={20} />
                <Title order={4}>{t("team.settings.members.title")}</Title>
              </Group>
              <Text size="sm" c="dimmed" mb="md">
                {t("team.settings.members.hint")}
              </Text>

              {isMobile ? (
                <Stack gap="xs">
                  {team.members
                    ?.filter((m: any) => m.isActive !== false)
                    ?.map((member: any) => (
                      <Paper
                        key={member.id}
                        withBorder
                        p="sm"
                        style={{
                          cursor:
                            member.role !== "OWNER" ? "pointer" : undefined,
                        }}
                        onClick={() => {
                          if (member.role === "OWNER") return;
                          setSelectedMember(member);
                          setRemoveMemberConfirm(false);
                          setMemberModalOpen(true);
                        }}
                      >
                        <Group justify="space-between" wrap="nowrap">
                          <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                            <Group gap="xs" wrap="nowrap">
                              <TbUser size={14} style={{ flexShrink: 0 }} />
                              <Text size="sm" fw={500} truncate>
                                {member.user?.username || "-"}
                              </Text>
                            </Group>
                            <Text size="xs" c="dimmed" truncate>
                              {member.user?.email}
                            </Text>
                          </Stack>
                          <Badge
                            variant="light"
                            color={
                              member.role === "OWNER"
                                ? "violet"
                                : member.role === "ADMIN"
                                  ? "blue"
                                  : "gray"
                            }
                            style={{ flexShrink: 0 }}
                          >
                            {member.role === "OWNER"
                              ? t("team.settings.members.role.owner")
                              : member.role === "ADMIN"
                                ? t("team.settings.members.role.admin")
                                : t("team.settings.members.role.member")}
                          </Badge>
                        </Group>
                      </Paper>
                    ))}
                </Stack>
              ) : (
                <Table striped highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>
                        {t("team.settings.members.table.name")}
                      </Table.Th>
                      <Table.Th>
                        {t("team.settings.members.table.email")}
                      </Table.Th>
                      <Table.Th>
                        {t("team.settings.members.table.role")}
                      </Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {team.members
                      ?.filter((m: any) => m.isActive !== false)
                      ?.map((member: any) => (
                        <Table.Tr
                          key={member.id}
                          style={{
                            cursor:
                              member.role !== "OWNER" ? "pointer" : undefined,
                          }}
                          onClick={() => {
                            if (member.role === "OWNER") return;
                            setSelectedMember(member);
                            setRemoveMemberConfirm(false);
                            setMemberModalOpen(true);
                          }}
                        >
                          <Table.Td>
                            <Group gap="xs">
                              <TbUser size={14} />
                              <Text size="sm" fw={500}>
                                {member.user?.username || "-"}
                              </Text>
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm">{member.user?.email}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Badge
                              variant="light"
                              color={
                                member.role === "OWNER"
                                  ? "violet"
                                  : member.role === "ADMIN"
                                    ? "blue"
                                    : "gray"
                              }
                            >
                              {member.role === "OWNER"
                                ? t("team.settings.members.role.owner")
                                : member.role === "ADMIN"
                                  ? t("team.settings.members.role.admin")
                                  : t("team.settings.members.role.member")}
                            </Badge>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                  </Table.Tbody>
                </Table>
              )}
            </Paper>
          </>
        )}

        {/* ----- Préférences de notifications push ----- */}
        <Divider my="lg" />
        <Paper withBorder p="lg" mb="lg">
          <Group mb="md">
            <TbBell size={20} />
            <Title order={4}>{t("team.settings.notif.title")}</Title>
          </Group>
          <Text size="sm" c="dimmed" mb="md">
            {t("team.settings.notif.hint")}
          </Text>
          <SegmentedControl
            value={pushNotifMode}
            onChange={(val) => {
              setPushNotifMode(val);
              pushPrefMutation.mutate(val);
            }}
            data={[
              {
                value: "EVERY_FILE",
                label: t("team.settings.notif.everyFile"),
              },
              {
                value: "SHARES_ONLY",
                label: t("team.settings.notif.sharesOnly"),
              },
            ]}
            fullWidth
          />
          <Text size="xs" c="dimmed" mt="xs">
            {t("team.settings.notif.help")}
          </Text>
        </Paper>

        {/* ----- Quitter l'équipe (membres non-owner) ----- */}
        {myRole && myRole !== "OWNER" && (
          <>
            <Divider my="lg" />
            <Paper
              withBorder
              p="lg"
              mb="lg"
              style={{ borderColor: "var(--mantine-color-orange-4)" }}
            >
              <Stack>
                <Title order={4} c="orange">
                  {t("team.settings.leave.title")}
                </Title>
                <Text size="sm" c="dimmed">
                  {t("team.settings.leave.desc")}
                </Text>
                <Group justify="flex-end">
                  <Button
                    color="orange"
                    variant="outline"
                    leftSection={<TbUserMinus size={16} />}
                    onClick={() => leaveTeamMutation.mutate()}
                    loading={leaveTeamMutation.isPending}
                  >
                    {t("team.settings.leave.button")}
                  </Button>
                </Group>
              </Stack>
            </Paper>
          </>
        )}

        {myRole === "OWNER" && (
          <>
            <Divider my="lg" />
            <Paper
              withBorder
              p="lg"
              style={{ borderColor: "var(--mantine-color-red-4)" }}
            >
              <Stack>
                <Title order={4} c="red">
                  {t("team.settings.danger.title")}
                </Title>
                <Text size="sm" c="dimmed">
                  {t("team.settings.danger.desc")}{" "}
                  <Text span fw={700} c="red">
                    {t("team.settings.danger.permanent")}
                  </Text>
                  {t("team.settings.danger.rest")}
                </Text>
                <Group justify="flex-end">
                  <Button
                    color="red"
                    variant="outline"
                    leftSection={<TbTrash size={16} />}
                    onClick={() => {
                      setDeleteConfirmInput("");
                      setDeleteModalOpen(true);
                    }}
                  >
                    {t("team.settings.danger.deleteButton")}
                  </Button>
                </Group>
              </Stack>
            </Paper>

            {/* Modal de confirmation de suppression */}
            <Modal
              opened={deleteModalOpen}
              onClose={() => setDeleteModalOpen(false)}
              title={
                <Group gap="xs">
                  <TbAlertTriangle
                    size={20}
                    color="var(--mantine-color-red-6)"
                  />
                  <Text fw={700} c="red">
                    {t("team.settings.danger.modalTitle")}
                  </Text>
                </Group>
              }
              centered
            >
              <Stack gap="md">
                <Alert color="red" variant="light" icon={<TbAlertTriangle />}>
                  {t("team.settings.danger.modalAlert", { name: team.name })}
                  <ul style={{ margin: "8px 0 0 0", paddingLeft: 16 }}>
                    <li>{t("team.settings.danger.item.folders")}</li>
                    <li>{t("team.settings.danger.item.files")}</li>
                    <li>{t("team.settings.danger.item.shares")}</li>
                    <li>{t("team.settings.danger.item.members")}</li>
                    <li>{t("team.settings.danger.item.history")}</li>
                  </ul>
                </Alert>

                <Text size="sm" fw={500}>
                  {t("team.settings.danger.confirmHint")}{" "}
                  <Text span ff="monospace" fw={700} c="red">
                    {team.name}
                  </Text>
                </Text>

                <TextInput
                  placeholder={team.name}
                  value={deleteConfirmInput}
                  onChange={(e) => setDeleteConfirmInput(e.currentTarget.value)}
                  error={
                    deleteConfirmInput.length > 0 &&
                    deleteConfirmInput !== team.name
                      ? t("team.settings.danger.confirmError")
                      : undefined
                  }
                  styles={{
                    input: { borderColor: "var(--mantine-color-red-4)" },
                  }}
                />

                <Group justify="flex-end" gap="sm">
                  <Button
                    variant="default"
                    onClick={() => setDeleteModalOpen(false)}
                  >
                    {t("team.settings.danger.cancel")}
                  </Button>
                  <Button
                    color="red"
                    leftSection={<TbTrash size={16} />}
                    disabled={deleteConfirmInput !== team.name}
                    loading={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(deleteConfirmInput)}
                  >
                    {t("team.settings.danger.confirmDelete")}
                  </Button>
                </Group>
              </Stack>
            </Modal>
          </>
        )}

        {/* ----- Modal gestion d'un membre ----- */}
        <Modal
          opened={memberModalOpen}
          onClose={() => {
            setMemberModalOpen(false);
            setSelectedMember(null);
            setRemoveMemberConfirm(false);
          }}
          title={
            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
              <TbShieldCheck size={20} style={{ flexShrink: 0 }} />
              <Text fw={700} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                {selectedMember?.user?.username ||
                  selectedMember?.user?.email ||
                  t("team.settings.members.role.member")}
              </Text>
            </Group>
          }
          size={isMobile ? "calc(100vw - 24px)" : "lg"}
          styles={{
            content: {
              maxHeight: isMobile ? "45dvh" : undefined,
            },
            body: {
              maxHeight: isMobile ? "calc(45dvh - 64px)" : undefined,
              overflowY: isMobile ? "auto" : undefined,
            },
          }}
          centered
        >
          {selectedMember && (
            <Stack gap="md">
              <Group gap="lg" align="flex-start">
                <Text
                  size="sm"
                  c="dimmed"
                  style={{ minWidth: 0, flex: "1 1 220px" }}
                >
                  {t("team.settings.memberModal.email")}{" "}
                  <Text span fw={500} style={{ overflowWrap: "anywhere" }}>
                    {selectedMember.user?.email}
                  </Text>
                </Text>
                <Badge
                  variant="light"
                  color={selectedMember.role === "ADMIN" ? "blue" : "gray"}
                  style={{ flexShrink: 0 }}
                >
                  {selectedMember.role === "ADMIN"
                    ? t("team.settings.members.role.admin")
                    : t("team.settings.members.role.member")}
                </Badge>
              </Group>

              <Divider />

              <Title order={5}>
                <Group gap="xs">
                  <TbFolder size={16} />
                  {t("team.settings.memberModal.folderAccess")}
                </Group>
              </Title>

              {memberAccessLoading ? (
                <Box ta="center" py="md">
                  <Loader size="sm" />
                </Box>
              ) : memberAccess?.folders && memberAccess.folders.length > 0 ? (
                isMobile ? (
                  <Stack gap="sm">
                    {memberAccess.folders.map((folder) => (
                      <Card key={folder.id} withBorder padding="sm" radius="md">
                        <Stack gap="sm">
                          <Box
                            style={{
                              alignItems: "start",
                              columnGap: 8,
                              display: "grid",
                              gridTemplateColumns: "28px minmax(0, 1fr)",
                            }}
                          >
                            <Box
                              style={{
                                alignItems: "center",
                                display: "flex",
                                flexShrink: 0,
                                height: 28,
                                justifyContent: "center",
                                width: 28,
                              }}
                            >
                              <TbFolder
                                size={16}
                                color={
                                  folder.color || "var(--mantine-color-blue-6)"
                                }
                              />
                            </Box>
                            <Box style={{ minWidth: 0 }}>
                              <Text
                                size="sm"
                                fw={600}
                                style={{
                                  lineHeight: 1.25,
                                  overflowWrap: "anywhere",
                                  wordBreak: "break-word",
                                }}
                              >
                                {folder.name}
                              </Text>
                            </Box>
                          </Box>

                          <Group justify="space-between" gap="xs" wrap="wrap">
                            <Text size="xs" c="dimmed">
                              {t("team.settings.memberModal.table.currentPerm")}
                            </Text>
                            <Box>{permissionBadge(folder.permission)}</Box>
                          </Group>

                          <Group gap="xs" wrap="nowrap" align="center">
                            <Select
                              size="sm"
                              placeholder={t(
                                "team.settings.memberModal.selectPlaceholder",
                              )}
                              data={permissionOptions}
                              value={folder.permission ?? null}
                              onChange={(val) => {
                                if (val) {
                                  setFolderAccessMutation.mutate({
                                    folderId: folder.id,
                                    permission: val,
                                  });
                                }
                              }}
                              clearable={false}
                              style={{ minWidth: 0, flex: 1 }}
                            />
                            {folder.permission && (
                              <Tooltip
                                label={t(
                                  "team.settings.memberModal.removeRuleTooltip",
                                )}
                              >
                                <ActionIcon
                                  variant="light"
                                  color="red"
                                  size="lg"
                                  aria-label={t(
                                    "team.settings.memberModal.removeRuleTooltip",
                                  )}
                                  onClick={() =>
                                    removeFolderAccessMutation.mutate(folder.id)
                                  }
                                  style={{ flexShrink: 0 }}
                                >
                                  <TbTrash size={14} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                          </Group>
                        </Stack>
                      </Card>
                    ))}
                  </Stack>
                ) : (
                  <Table
                    striped
                    style={{ tableLayout: "fixed", width: "100%" }}
                  >
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>
                          {t("team.settings.memberModal.table.folder")}
                        </Table.Th>
                        <Table.Th style={{ width: 145 }}>
                          {t("team.settings.memberModal.table.currentPerm")}
                        </Table.Th>
                        <Table.Th style={{ width: 140 }}>
                          {t("team.settings.memberModal.table.edit")}
                        </Table.Th>
                        <Table.Th style={{ width: 44 }}></Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {memberAccess.folders.map((folder) => (
                        <Table.Tr key={folder.id}>
                          <Table.Td>
                            <Group gap="xs" align="center" wrap="nowrap">
                              <TbFolder
                                size={14}
                                color={
                                  folder.color || "var(--mantine-color-blue-6)"
                                }
                                style={{ flexShrink: 0 }}
                              />
                              <Text
                                size="sm"
                                style={{
                                  lineHeight: 1.25,
                                  minWidth: 0,
                                  overflowWrap: "anywhere",
                                }}
                              >
                                {folder.name}
                              </Text>
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            {permissionBadge(folder.permission)}
                          </Table.Td>
                          <Table.Td>
                            <Select
                              size="xs"
                              w="100%"
                              placeholder={t(
                                "team.settings.memberModal.selectPlaceholder",
                              )}
                              data={permissionOptions}
                              value={folder.permission ?? null}
                              onChange={(val) => {
                                if (val) {
                                  setFolderAccessMutation.mutate({
                                    folderId: folder.id,
                                    permission: val,
                                  });
                                }
                              }}
                              clearable={false}
                            />
                          </Table.Td>
                          <Table.Td>
                            {folder.permission && (
                              <Tooltip
                                label={t(
                                  "team.settings.memberModal.removeRuleTooltip",
                                )}
                              >
                                <ActionIcon
                                  variant="light"
                                  color="gray"
                                  size="sm"
                                  aria-label={t(
                                    "team.settings.memberModal.removeRuleTooltip",
                                  )}
                                  onClick={() =>
                                    removeFolderAccessMutation.mutate(folder.id)
                                  }
                                >
                                  <TbTrash size={14} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                )
              ) : (
                <Text size="sm" c="dimmed" ta="center" py="md">
                  {t("team.settings.memberModal.noFolders")}
                </Text>
              )}

              <Text size="xs" c="dimmed">
                {t("team.settings.memberModal.accessHelp")}
              </Text>

              <Divider />

              {/* Retirer le membre */}
              {!removeMemberConfirm ? (
                <Group justify="flex-end">
                  <Button
                    color="red"
                    variant="light"
                    leftSection={<TbUserMinus size={16} />}
                    onClick={() => setRemoveMemberConfirm(true)}
                  >
                    {t("team.settings.memberModal.removeButton")}
                  </Button>
                </Group>
              ) : (
                <Alert color="red" variant="light">
                  <Stack gap="sm">
                    <Text size="sm" fw={500}>
                      {t("team.settings.memberModal.removeConfirm", {
                        email: selectedMember.user?.email,
                      })}
                    </Text>
                    <Group justify="flex-end" gap="sm">
                      <Button
                        variant="default"
                        size="xs"
                        onClick={() => setRemoveMemberConfirm(false)}
                      >
                        {t("team.settings.memberModal.cancel")}
                      </Button>
                      <Button
                        color="red"
                        size="xs"
                        leftSection={<TbTrash size={14} />}
                        loading={removeMemberMutation.isPending}
                        onClick={() =>
                          removeMemberMutation.mutate(selectedMember.id)
                        }
                      >
                        {t("team.settings.memberModal.confirmRemove")}
                      </Button>
                    </Group>
                  </Stack>
                </Alert>
              )}
            </Stack>
          )}
        </Modal>
      </Container>
    </>
  );
};

export default TeamSettings;
