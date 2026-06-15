import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Container,
  Grid,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  Progress,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
  Popover,
  CopyButton,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
  TbChartBar,
  TbCheck,
  TbCopy,
  TbDotsVertical,
  TbDownload,
  TbFolder,
  TbFolderPlus,
  TbKey,
  TbLock,
  TbLockOpen,
  TbMail,
  TbSettings,
  TbShieldCheck,
  TbTrash,
  TbUsers,
  TbUserDown,
  TbUserPlus,
  TbFileDescription,
  TbFileOff,
} from "react-icons/tb";
import { useIntl } from "react-intl";
import Meta from "../../../components/Meta";
import teamService from "../../../services/team.service";
import signingService from "../../../services/signing.service";
import {
  generateEncryptionKey,
  getUserKey,
  importKeyFromBase64,
  exportKeyToBase64,
  unwrapReverseShareKey,
  wrapReverseShareKey,
  extractTeamKeyFromHash,
} from "../../../utils/crypto.util";
import { reencryptTeam, TeamReencryptProgress } from "../../../utils/reencrypt.util";
import toast from "../../../utils/toast.util";
import useUser from "../../../hooks/user.hook";
import useTranslate from "../../../hooks/useTranslate.hook";

const formatBytes = (bytes: number) => {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
};

const VALID_TABS = ["members", "folders", "activity", "signatures"] as const;

const TeamDashboard = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const t = useTranslate();
  const intl = useIntl();
  const { id: teamId, tab: queryTab } = router.query;
  const teamIdStr = Array.isArray(teamId) ? teamId[0] : teamId || "";
  const rawTab = Array.isArray(queryTab) ? queryTab[0] : queryTab;
  const user = useUser();
  const isMobile = useMediaQuery("(max-width: 680px)");

  // Redirect if not authenticated.
  useEffect(() => {
    if (user.user === null) {
      router.replace(`/auth/signIn?redirect=/team/${teamIdStr}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.user]);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("MEMBER");
  const [inviteOpened, { open: openInvite, close: closeInvite }] =
    useDisclosure(false);
  const [folderName, setFolderName] = useState("");
  const [folderOpened, { open: openFolder, close: closeFolder }] =
    useDisclosure(false);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleteFolderConfirm, setDeleteFolderConfirm] = useState("");
  const [removeMemberTarget, setRemoveMemberTarget] = useState<{
    id: string;
    username: string;
    email: string;
  } | null>(null);
  const [secureInviteLink, setSecureInviteLink] = useState<string | null>(null);

  // E2E state
  const [myWrappedTeamKey, setMyWrappedTeamKey] = useState<string | null | undefined>(undefined); // undefined=loading, null=none
  const [e2eInitializing, setE2eInitializing] = useState(false);
  const [memberKeyLinks, setMemberKeyLinks] = useState<Record<string, string>>({}); // memberId to secure link
  const [initLinksOpened, { open: openInitLinks, close: closeInitLinks }] = useDisclosure(false);
  const [allMemberLinks, setAllMemberLinks] = useState<{ memberId: string; name: string; email: string; link: string }[]>([]);
  const [rotateOpened, { open: openRotate, close: closeRotate }] = useDisclosure(false);
  const [rotateProgress, setRotateProgress] = useState<TeamReencryptProgress | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotateAbort, setRotateAbort] = useState<AbortController | null>(null);
  const [cancellingRotation, setCancellingRotation] = useState(false);

  // On mount: check if user has wrappedTeamKey; also auto-capture if #teamKey= in URL
  useEffect(() => {
    if (!teamIdStr || !user.user) return;
    let cancelled = false;
    (async () => {
      try {
        const userKeyB64 = getUserKey();
        // 1. Check if #teamKey= is in URL (key received from admin)
        const fragmentTeamKey = extractTeamKeyFromHash();
        if (fragmentTeamKey && userKeyB64) {
          const teamKey = await importKeyFromBase64(fragmentTeamKey);
          const masterKey = await importKeyFromBase64(userKeyB64);
          const wrapped = await wrapReverseShareKey(teamKey, masterKey);
          await teamService.setTeamKey(teamIdStr, wrapped);
          if (!cancelled) {
            setMyWrappedTeamKey(wrapped);
            toast.success(t("team.dashboard.e2e.keyReceivedSuccess"));
            // Clean fragment from URL
            router.replace(router.asPath.split("#")[0], undefined, { shallow: true });
          }
          return;
        }
        // 2. Load existing key from server
        const { wrappedTeamKey } = await teamService.getTeamKey(teamIdStr);
        if (!cancelled) setMyWrappedTeamKey(wrappedTeamKey);
      } catch {
        if (!cancelled) setMyWrappedTeamKey(null);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamIdStr, user.user]);

  // Initialize K_team for a team that has none (OWNER action)
  const handleInitE2E = async () => {
    const userKeyB64 = getUserKey();
    if (!userKeyB64) {
      toast.error(t("team.dashboard.e2e.personalKeyMissing"));
      return;
    }
    setE2eInitializing(true);
    try {
      const teamKey = await generateEncryptionKey();
      const masterKey = await importKeyFromBase64(userKeyB64);
      const wrapped = await wrapReverseShareKey(teamKey, masterKey);
      await teamService.setTeamKey(teamIdStr, wrapped);
      setMyWrappedTeamKey(wrapped);

      // Automatically generate sharing links for all existing members who don't have the key
      const teamKeyB64 = await exportKeyToBase64(teamKey);
      const otherMembers = (team?.members ?? []).filter(
        (m: any) => !m.hasTeamKey && m.user?.id !== user.user?.id,
      );
      const links = otherMembers.map((m: any) => ({
        memberId: m.id,
        name: m.user?.username || m.user?.email || t("team.dashboard.roles.member"),
        email: m.user?.email || "",
        link: `${window.location.origin}/team/${teamIdStr}#teamKey=${teamKeyB64}`,
      }));
      // Also store them in the per-member state for the table
      const perMember: Record<string, string> = {};
      links.forEach((l) => { perMember[l.memberId] = l.link; });
      setMemberKeyLinks((prev) => ({ ...prev, ...perMember }));

      if (links.length > 0) {
        setAllMemberLinks(links);
        openInitLinks();
      } else {
        toast.success(t("team.dashboard.e2e.activatedSoleMember"));
      }
    } catch (e) {
      toast.error(t("team.dashboard.e2e.initError"));
      console.error(e);
    } finally {
      setE2eInitializing(false);
    }
  };

  // Generate a secure key-sharing link for a specific member
  const handleShareKeyToMember = async (memberId: string) => {
    const userKeyB64 = getUserKey();
    if (!userKeyB64 || !myWrappedTeamKey) return;
    try {
      const masterKey = await importKeyFromBase64(userKeyB64);
      const teamKey = await unwrapReverseShareKey(myWrappedTeamKey, masterKey);
      const teamKeyB64 = await exportKeyToBase64(teamKey);
      const link = `${window.location.origin}/team/${teamIdStr}#teamKey=${teamKeyB64}`;
      setMemberKeyLinks((prev) => ({ ...prev, [memberId]: link }));
    } catch (e) {
      toast.error(t("team.dashboard.e2e.shareLinkError"));
      console.error(e);
    }
  };

  // Rotate K_team: re-encrypt all team files, then swap key and invalidate all other members
  const handleRotateKey = async () => {
    const userKeyB64 = getUserKey();
    if (!userKeyB64 || !myWrappedTeamKey) {
      toast.error(t("team.dashboard.e2e.keyUnavailable"));
      return;
    }
    setRotating(true);
    setRotateProgress(null);
    const ac = new AbortController();
    setRotateAbort(ac);
    try {
      const masterKey = await importKeyFromBase64(userKeyB64);
      const oldTeamKey = await unwrapReverseShareKey(myWrappedTeamKey, masterKey);
      const oldTeamKeyB64 = await exportKeyToBase64(oldTeamKey);

      // Generate new K_team
      const newTeamKey = await generateEncryptionKey();
      const newTeamKeyB64 = await exportKeyToBase64(newTeamKey);

      // Phase 1: re-encrypt all team files from old key to new key.
      const result = await reencryptTeam(
        teamIdStr,
        oldTeamKeyB64,
        newTeamKeyB64,
        (p) => setRotateProgress(p),
        ac.signal,
      );

      if (result.filesFailed > 0) {
        toast.error(t("team.dashboard.e2e.rotatePartialFail", { n: result.filesFailed }));
        setRotating(false);
        return;
      }

      // Phase 2: wrap new key with user's master key and call rotateTeamKey (invalidates others)
      const newWrapped = await wrapReverseShareKey(newTeamKey, masterKey);
      await teamService.rotateTeamKey(teamIdStr, newWrapped);
      setMyWrappedTeamKey(newWrapped);

      // Phase 3: generate distribution links for all OTHER active members
      const otherMembers = (team?.members ?? []).filter(
        (m: any) => m.isActive && m.user?.id !== user.user?.id,
      );
      const links = otherMembers.map((m: any) => ({
        memberId: m.id,
        name: m.user?.username || m.user?.email || t("team.dashboard.roles.member"),
        email: m.user?.email || "",
        link: `${window.location.origin}/team/${teamIdStr}#teamKey=${newTeamKeyB64}`,
      }));
      const perMember: Record<string, string> = {};
      links.forEach((l) => { perMember[l.memberId] = l.link; });
      setMemberKeyLinks((prev) => ({ ...prev, ...perMember }));

      if (links.length > 0) {
        setAllMemberLinks(links);
        openInitLinks();
      }

      toast.success(
        t("team.dashboard.e2e.rotateSuccess", { n: result.filesReencrypted }) +
          (links.length === 0
            ? ` ${t("team.dashboard.e2e.noOtherMembers")}`
            : ""),
      );
      closeRotate();
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
    } catch (e: any) {
      if (e?.message?.includes("annulé")) {
        toast.error(t("team.dashboard.e2e.rotateCancelled"));
      } else {
        toast.error(t("team.dashboard.e2e.rotateError"));
        console.error(e);
      }
    } finally {
      setRotating(false);
      setRotateAbort(null);
      setCancellingRotation(false);
    }
  };

  // Fetch team data
  const { data: team, isLoading: teamLoading } = useQuery({
    queryKey: ["team", teamIdStr],
    queryFn: () => teamService.getTeam(teamIdStr),
    enabled: !!teamIdStr,
  });

  // Current user role in this team
  const myMember = useMemo(() => {
    if (!team?.members || !user.user) return null;
    return team.members.find((m: any) => m.user?.id === user.user!.id) ?? null;
  }, [team, user.user]);
  const myRole = myMember?.role ?? null;
  const isTeamAdmin = myRole === "OWNER" || myRole === "ADMIN";
  const canViewActivity = isTeamAdmin || !!myMember?.canViewActivity;
  const canViewSignatures = isTeamAdmin || !!myMember?.canViewSignatures;
  const configuredFolderLimit = parseInt(
    process.env.NEXT_PUBLIC_TEAM_MAX_FOLDERS || "0",
    10,
  );
  const hasFolderLimit = Number.isFinite(configuredFolderLimit) && configuredFolderLimit > 0;

  const activeTab = useMemo(() => {
    if (!rawTab || !(VALID_TABS as readonly string[]).includes(rawTab)) return "members";
    if (rawTab === "activity" && !canViewActivity) return "members";
    if (rawTab === "signatures" && !canViewSignatures) return "members";
    return rawTab;
  }, [rawTab, canViewActivity, canViewSignatures]);

  // Fetch metrics
  const { data: metrics } = useQuery({
    queryKey: ["team.metrics", teamIdStr],
    queryFn: () => teamService.getMetrics(teamIdStr),
    enabled: !!teamIdStr,
  });

  // Fetch folders
  const { data: folders } = useQuery({
    queryKey: ["team.folders", teamIdStr],
    queryFn: () => teamService.getFolders(teamIdStr),
    enabled: !!teamIdStr,
  });

  // Fetch access logs (admin/owner or members with canViewActivity)
  const { data: logsData } = useQuery({
    queryKey: ["team.logs", teamIdStr],
    queryFn: () => teamService.getAccessLogs(teamIdStr, { limit: 20 }),
    enabled: !!teamIdStr && canViewActivity,
  });

  // Fetch team signature documents
  const { data: teamSignatures } = useQuery({
    queryKey: ["team.signatures", teamIdStr],
    queryFn: () => signingService.getTeamDocuments(teamIdStr),
    enabled: !!teamIdStr && canViewSignatures,
  });

  // Mutations
  const inviteMutation = useMutation({
    mutationFn: () =>
      teamService.inviteMember(teamIdStr, {
        email: inviteEmail,
        role: inviteRole,
      }),
    onSuccess: async (data) => {
      toast.success(t("team.dashboard.invite.sentSuccess", { email: inviteEmail }));
      setInviteEmail("");

      // Build secure invitation link with team key in fragment (use already-loaded key)
      try {
        const userKeyB64 = getUserKey();
        if (userKeyB64 && data.invitationToken && myWrappedTeamKey) {
          const masterKey = await importKeyFromBase64(userKeyB64);
          const teamKey = await unwrapReverseShareKey(myWrappedTeamKey, masterKey);
          const teamKeyB64 = await exportKeyToBase64(teamKey);
          const baseUrl = window.location.origin;
          const link = `${baseUrl}/team/invite/${data.invitationToken}#teamKey=${teamKeyB64}`;
          setSecureInviteLink(link);
        } else if (!myWrappedTeamKey) {
          toast.error(t("team.dashboard.e2e.noKeyForInvite"));
        }
      } catch (e) {
        console.warn("[E2E] Could not build secure invite link:", e);
      }

      closeInvite();
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.message || t("team.dashboard.invite.error")),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (memberId: string) =>
      teamService.removeMember(teamIdStr, memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
      toast.success(t("team.dashboard.members.removedSuccess"));
      setRemoveMemberTarget(null);
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: string }) =>
      teamService.updateMemberRole(teamIdStr, memberId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
      toast.success(t("team.dashboard.members.roleUpdated"));
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.message || t("team.dashboard.members.roleChangeError")),
  });

  const updatePermissionsMutation = useMutation({
    mutationFn: ({
      memberId,
      permissions,
    }: {
      memberId: string;
      permissions: { canViewActivity?: boolean; canViewSignatures?: boolean };
    }) => teamService.updateMemberPermissions(teamIdStr, memberId, permissions),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
      toast.success(t("team.dashboard.members.permissionsUpdated"));
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.message || t("team.dashboard.members.permissionsError")),
  });

  const createFolderMutation = useMutation({
    mutationFn: () => teamService.createFolder(teamIdStr, { name: folderName }),
    onSuccess: () => {
      toast.success(t("team.dashboard.folders.createdSuccess"));
      setFolderName("");
      closeFolder();
      queryClient.invalidateQueries({ queryKey: ["team.folders", teamIdStr] });
      queryClient.invalidateQueries({ queryKey: ["team.logs", teamIdStr] });
      queryClient.invalidateQueries({ queryKey: ["teams", "writable-folders"] });
    },
    onError: () => toast.error(t("team.dashboard.folders.createError")),
  });

  const deleteFolderMutation = useMutation({
    mutationFn: ({ folderId, confirmationName }: { folderId: string; confirmationName: string }) =>
      teamService.deleteFolder(teamIdStr, folderId, confirmationName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team.folders", teamIdStr] });
      queryClient.invalidateQueries({ queryKey: ["teams", "writable-folders"] });
      toast.success(t("team.dashboard.folders.deletedSuccess"));
      setDeleteFolderTarget(null);
      setDeleteFolderConfirm("");
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.message || t("team.dashboard.folders.deleteError")),
  });

  if (teamLoading || !teamIdStr) {
    return (
      <Container size="lg" mt="xl" px={0}>
        <Box ta="center" py="xl">
          <Loader size="lg" />
        </Box>
      </Container>
    );
  }

  if (!team) {
    return (
      <Container size="lg" mt="xl" px={0}>
        <Alert color="red">{t("team.dashboard.error.notFound")}</Alert>
      </Container>
    );
  }

  return (
    <>
      <Meta title={t("team.dashboard.meta.title", { name: team.name })} />
      <Container size="lg" mt="xl" mb="xl" px={0}>
        {/* Header */}
        <Group justify="space-between" mb="lg">
          <Stack gap={2}>
            <Title order={2}>{team.name}</Title>
            {team.description && (
              <Text c="dimmed" size="sm">
                {team.description}
              </Text>
            )}
          </Stack>
          <Group>
            {isTeamAdmin && (
              <Button
                variant="light"
                leftSection={<TbUserPlus size={16} />}
                onClick={openInvite}
              >
                {t("team.dashboard.buttons.invite")}
              </Button>
            )}
            {isTeamAdmin && (
              <Button
                variant="subtle"
                leftSection={<TbSettings size={16} />}
                onClick={() => router.push(`/team/${teamIdStr}/settings`)}
              >
                {t("team.dashboard.buttons.settings")}
              </Button>
            )}
            {!isTeamAdmin && myRole === "MEMBER" && (
              <Button
                variant="subtle"
                leftSection={<TbSettings size={16} />}
                onClick={() => router.push(`/team/${teamIdStr}/settings`)}
              >
                {t("team.dashboard.buttons.settings")}
              </Button>
            )}
          </Group>
        </Group>

        {/* Metrics cards */}
        {metrics && (
          <Grid mb="lg">
            <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
              <Card withBorder padding="md" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                  {t("team.dashboard.metrics.storage")}
                </Text>
                <Stack justify="space-between" style={{ flex: 1, marginTop: 8 }}>
                  <Text fw={700} size="xl">
                    {formatBytes(metrics.storage.used)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {metrics.storage.limit > 0
                      ? `${formatBytes(metrics.storage.used)} / ${formatBytes(metrics.storage.limit)}`
                      : formatBytes(metrics.storage.used)
                    }
                  </Text>
                </Stack>
              </Card>
            </Grid.Col>

            <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
              <Card withBorder padding="md" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                  {t("team.dashboard.metrics.members")}
                </Text>
                <Stack justify="space-between" style={{ flex: 1, marginTop: 8 }}>
                  <Text fw={700} size="xl">
                    {metrics.team.membersCount}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {metrics.team.maxMembers > 0
                      ? `${metrics.team.membersCount} / ${metrics.team.maxMembers}`
                      : t("team.dashboard.metrics.members")
                    }
                  </Text>
                </Stack>
              </Card>
            </Grid.Col>

            <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
              <Card withBorder padding="md" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                  {t("team.dashboard.metrics.downloads30d")}
                </Text>
                <Stack justify="space-between" style={{ flex: 1, marginTop: 8 }}>
                  <Text fw={700} size="xl">
                    {metrics.activity.downloads}
                  </Text>
                  <Group gap={4}>
                    <TbDownload size={12} />
                    <Text size="xs" c="dimmed">
                      {metrics.activity.uploads} uploads
                    </Text>
                  </Group>
                </Stack>
              </Card>
            </Grid.Col>

            <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
              <Card withBorder padding="md" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                  {t("team.dashboard.metrics.files")}
                </Text>
                <Stack justify="space-between" style={{ flex: 1, marginTop: 8 }}>
                  <Text fw={700} size="xl">
                    {metrics.activity.totalFiles}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t("team.dashboard.metrics.foldersCount", { n: metrics.team.foldersCount })}
                  </Text>
                </Stack>
              </Card>
            </Grid.Col>
          </Grid>
        )}

        {/* E2E banner */}
        {myWrappedTeamKey === undefined ? null : myWrappedTeamKey === null && isTeamAdmin ? (
          <Alert icon={<TbLock size={18} />} color="orange" mb="md" title={t("team.dashboard.e2e.banner.notInitTitle")}>
            <Text size="sm" mb="sm">
              {t("team.dashboard.e2e.banner.notInitDesc")}
            </Text>
            <Button
              size="compact-sm"
              color="orange"
              leftSection={<TbKey size={14} />}
              loading={e2eInitializing}
              onClick={handleInitE2E}
            >
              {t("team.dashboard.e2e.initButton")}
            </Button>
          </Alert>
        ) : myWrappedTeamKey === null && !isTeamAdmin ? (
          <Alert icon={<TbLock size={18} />} color="blue" mb="md" title={t("team.dashboard.e2e.banner.missingTitle")}>
            {t("team.dashboard.e2e.banner.missingDesc")}
          </Alert>
        ) : myWrappedTeamKey ? (
          <Alert icon={<TbLockOpen size={18} />} color="green" mb="md" title={t("team.dashboard.e2e.banner.activeTitle")}>
            <Text size="sm" mb={isTeamAdmin ? "sm" : undefined}>
              {t("team.dashboard.e2e.banner.activeDesc")}
            </Text>
            {isTeamAdmin && (
              <Button
                size="compact-sm"
                color="orange"
                variant="light"
                leftSection={<TbKey size={14} />}
                onClick={openRotate}
              >
                {t("team.dashboard.e2e.rotateButton")}
              </Button>
            )}
          </Alert>
        ) : null}

        {/* Tabs: Members, Folders, Activity */}
        <Tabs
          value={activeTab}
          onChange={(tab) => {
            if (tab) {
              router.replace(
                { pathname: router.pathname, query: { ...router.query, tab } },
                undefined,
                { shallow: true },
              );
            }
          }}
        >
          <Tabs.List mb="md">
            <Tabs.Tab value="members" leftSection={<TbUsers size={16} />}>
              {t("team.dashboard.tabs.members")}
            </Tabs.Tab>
            <Tabs.Tab value="folders" leftSection={<TbFolder size={16} />}>
              {t("team.dashboard.tabs.folders")}
            </Tabs.Tab>
            {canViewActivity && (
              <Tabs.Tab value="activity" leftSection={<TbChartBar size={16} />}>
                {t("team.dashboard.tabs.activity")}
              </Tabs.Tab>
            )}
            {canViewSignatures && (
              <Tabs.Tab value="signatures" leftSection={<TbFileDescription size={16} />}>
                {t("team.dashboard.tabs.signatures")}
                {teamSignatures && teamSignatures.length > 0 && (
                  <Badge size="xs" variant="filled" ml={6}>{teamSignatures.length}</Badge>
                )}
              </Tabs.Tab>
            )}
          </Tabs.List>

          {/* Members tab */}
          <Tabs.Panel value="members">
            {isMobile ? (
            <Stack gap="sm">
              {team.members?.map((member) => (
                <Card key={member.id} withBorder padding="sm">
                  <Group justify="space-between" mb={4}>
                    <Text fw={600} size="sm">{member.user?.username || "-"}</Text>
                    <Badge
                      variant="light"
                      size="sm"
                      color={member.role === "OWNER" ? "violet" : member.role === "ADMIN" ? "blue" : "gray"}
                    >
                      {member.role === "OWNER" ? t("team.dashboard.roles.owner") : member.role === "ADMIN" ? t("team.dashboard.roles.admin") : t("team.dashboard.roles.member")}
                    </Badge>
                  </Group>
                  <Text size="xs" c="dimmed" mb={4}>{member.user?.email}</Text>
                  <Group gap={4}>
                    {isTeamAdmin && myWrappedTeamKey && !member.hasTeamKey && (
                      <Tooltip label={t("team.dashboard.e2e.generateLinkTooltip")}>
                        <ActionIcon variant="subtle" color="orange" size="sm" onClick={() => handleShareKeyToMember(member.id)}>
                          <TbKey size={14} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    {isTeamAdmin && member.hasTeamKey && (
                      <Tooltip label={t("team.dashboard.e2e.keyOkTooltip")}>
                        <ActionIcon variant="subtle" color="green" size="sm" style={{ cursor: "default" }}>
                          <TbLockOpen size={14} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    {memberKeyLinks[member.id] && (
                      <Popover width={300} position="bottom-end" withArrow>
                        <Popover.Target>
                          <Button size="compact-xs" variant="light" color="orange">{t("team.dashboard.e2e.linkReady")}</Button>
                        </Popover.Target>
                        <Popover.Dropdown>
                          <Text size="xs" mb="xs">{t("team.dashboard.e2e.shareLinkTo", { name: member.user?.username })} </Text>
                          <TextInput readOnly size="xs" value={memberKeyLinks[member.id]}
                            rightSection={
                              <CopyButton value={memberKeyLinks[member.id]}>
                                {({ copied, copy }) => (
                                  <ActionIcon color={copied ? "green" : "blue"} onClick={copy} size="sm">
                                    {copied ? <TbCheck size={12} /> : <TbCopy size={12} />}
                                  </ActionIcon>
                                )}
                              </CopyButton>
                            }
                          />
                        </Popover.Dropdown>
                      </Popover>
                    )}
                    {member.role !== "OWNER" && isTeamAdmin && (
                      <Menu position="bottom-end" withinPortal>
                        <Menu.Target>
                          <ActionIcon variant="subtle" color="gray" size="sm">
                            <TbDotsVertical size={14} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          {member.role === "MEMBER" && (
                            <Menu.Item leftSection={<TbShieldCheck size={14} />} onClick={() => updateRoleMutation.mutate({ memberId: member.id, role: "ADMIN" })}>
                              {t("team.dashboard.members.promoteAdmin")}
                            </Menu.Item>
                          )}
                          {member.role === "ADMIN" && (
                            <Menu.Item leftSection={<TbUserDown size={14} />} onClick={() => updateRoleMutation.mutate({ memberId: member.id, role: "MEMBER" })}>
                              {t("team.dashboard.members.demoteToMember")}
                            </Menu.Item>
                          )}
                          {member.role === "MEMBER" && (
                            <>
                              <Menu.Divider />
                              <Menu.Item
                                leftSection={<TbChartBar size={14} />}
                                onClick={() =>
                                  updatePermissionsMutation.mutate({
                                    memberId: member.id,
                                    permissions: { canViewActivity: !member.canViewActivity },
                                  })
                                }
                              >
                                {member.canViewActivity ? t("team.dashboard.members.revokeActivity") : t("team.dashboard.members.grantActivity")}
                              </Menu.Item>
                              <Menu.Item
                                leftSection={<TbFileDescription size={14} />}
                                onClick={() =>
                                  updatePermissionsMutation.mutate({
                                    memberId: member.id,
                                    permissions: { canViewSignatures: !member.canViewSignatures },
                                  })
                                }
                              >
                                {member.canViewSignatures ? t("team.dashboard.members.revokeSignatures") : t("team.dashboard.members.grantSignatures")}
                              </Menu.Item>
                            </>
                          )}
                          <Menu.Divider />
                          <Menu.Item color="red" leftSection={<TbTrash size={14} />} onClick={() => setRemoveMemberTarget({ id: member.id, username: member.user?.username || "", email: member.user?.email || "" })}>
                            {t("team.dashboard.members.remove")}
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    )}
                  </Group>
                </Card>
              ))}
            </Stack>
            ) : (
            <Paper withBorder style={{ overflowX: "auto" }}>
              <Table striped highlightOnHover style={{ minWidth: 650 }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("team.dashboard.members.table.member")}</Table.Th>
                    <Table.Th>{t("team.dashboard.members.table.email")}</Table.Th>
                    <Table.Th>{t("team.dashboard.members.table.role")}</Table.Th>
                    <Table.Th>{t("team.dashboard.members.table.actions")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {team.members?.map((member) => (
                    <Table.Tr key={member.id}>
                      <Table.Td>
                        <Text fw={500}>
                          {member.user?.username || "-"}
                        </Text>
                      </Table.Td>
                      <Table.Td>{member.user?.email}</Table.Td>
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
                            ? t("team.dashboard.roles.owner")
                            : member.role === "ADMIN"
                              ? t("team.dashboard.roles.admin")
                              : t("team.dashboard.roles.member")}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} align="center">
                          {/* E2E key status badge */}
                          {isTeamAdmin && myWrappedTeamKey && !member.hasTeamKey && (
                            <Tooltip label={t("team.dashboard.e2e.memberNoKeyTooltip")}>
                              <ActionIcon
                                variant="subtle"
                                color="orange"
                                onClick={() => handleShareKeyToMember(member.id)}
                              >
                                <TbKey size={14} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                          {isTeamAdmin && member.hasTeamKey && (
                            <Tooltip label={t("team.dashboard.e2e.memberHasKeyTooltip")}>
                              <ActionIcon variant="subtle" color="green" style={{ cursor: "default" }}>
                                <TbLockOpen size={14} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                          {/* Link modal for this member */}
                          {memberKeyLinks[member.id] && (
                            <Popover width={400} position="bottom-end" withArrow>
                              <Popover.Target>
                                <Button size="compact-xs" variant="light" color="orange">
                                  {t("team.dashboard.e2e.linkReady")}
                                </Button>
                              </Popover.Target>
                              <Popover.Dropdown>
                                <Text size="xs" mb="xs">
                                  {t("team.dashboard.e2e.shareLinkTo", { name: member.user?.username })}
                                </Text>
                                <TextInput
                                  readOnly
                                  size="xs"
                                  value={memberKeyLinks[member.id]}
                                  rightSection={
                                    <CopyButton value={memberKeyLinks[member.id]}>
                                      {({ copied, copy }) => (
                                        <ActionIcon color={copied ? "green" : "blue"} onClick={copy} size="sm">
                                          {copied ? <TbCheck size={12} /> : <TbCopy size={12} />}
                                        </ActionIcon>
                                      )}
                                    </CopyButton>
                                  }
                                />
                                <Text size="xs" c="dimmed" mt="xs">
                                  {t("team.dashboard.e2e.linkSecurityWarning")}
                                </Text>
                              </Popover.Dropdown>
                            </Popover>
                          )}
                          {member.role !== "OWNER" && isTeamAdmin && (
                          <Group gap={4}>
                            <Menu position="bottom-end" withinPortal>
                              <Menu.Target>
                                <ActionIcon variant="subtle" color="gray">
                                  <TbDotsVertical size={14} />
                                </ActionIcon>
                              </Menu.Target>
                              <Menu.Dropdown>
                                {member.role === "MEMBER" && (
                                  <Menu.Item
                                    leftSection={<TbShieldCheck size={14} />}
                                    onClick={() =>
                                      updateRoleMutation.mutate({
                                        memberId: member.id,
                                        role: "ADMIN",
                                      })
                                    }
                                  >
                                    {t("team.dashboard.members.promoteAdmin")}
                                  </Menu.Item>
                                )}
                                {member.role === "ADMIN" && (
                                  <Menu.Item
                                    leftSection={<TbUserDown size={14} />}
                                    onClick={() =>
                                      updateRoleMutation.mutate({
                                        memberId: member.id,
                                        role: "MEMBER",
                                      })
                                    }
                                  >
                                    {t("team.dashboard.members.demoteToMember")}
                                  </Menu.Item>
                                )}
                                {member.role === "MEMBER" && (
                                  <>
                                    <Menu.Divider />
                                    <Menu.Item
                                      leftSection={<TbChartBar size={14} />}
                                      onClick={() =>
                                        updatePermissionsMutation.mutate({
                                          memberId: member.id,
                                          permissions: { canViewActivity: !member.canViewActivity },
                                        })
                                      }
                                    >
                                      {member.canViewActivity ? t("team.dashboard.members.revokeActivity") : t("team.dashboard.members.grantActivity")}
                                    </Menu.Item>
                                    <Menu.Item
                                      leftSection={<TbFileDescription size={14} />}
                                      onClick={() =>
                                        updatePermissionsMutation.mutate({
                                          memberId: member.id,
                                          permissions: { canViewSignatures: !member.canViewSignatures },
                                        })
                                      }
                                    >
                                      {member.canViewSignatures ? t("team.dashboard.members.revokeSignatures") : t("team.dashboard.members.grantSignatures")}
                                    </Menu.Item>
                                  </>
                                )}
                                <Menu.Divider />
                                <Menu.Item
                                  color="red"
                                  leftSection={<TbTrash size={14} />}
                                  onClick={() =>
                                    setRemoveMemberTarget({
                                      id: member.id,
                                      username: member.user?.username || "",
                                      email: member.user?.email || "",
                                    })
                                  }
                                >
                                  {t("team.dashboard.members.remove")}
                                </Menu.Item>
                              </Menu.Dropdown>
                            </Menu>
                          </Group>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Paper>
            )}
          </Tabs.Panel>

          {/* Folders tab */}
          <Tabs.Panel value="folders">
            <Group justify="space-between" mb="md">
              <Text size="sm" c="dimmed">
                {hasFolderLimit
                  ? t("team.dashboard.folders.count", { n: folders?.length || 0, max: configuredFolderLimit })
                  : `${folders?.length || 0} dossier(s)`}
              </Text>
              {isTeamAdmin && (
                <Button
                  size="compact-sm"
                  leftSection={<TbFolderPlus size={14} />}
                  onClick={openFolder}
                  disabled={hasFolderLimit && (folders?.length || 0) >= configuredFolderLimit}
                >
                  {t("team.dashboard.buttons.newFolder")}
                </Button>
              )}
            </Group>

            {(!folders || folders.length === 0) && (
              <Paper withBorder p="xl" ta="center">
                <Text c="dimmed">{t("team.dashboard.folders.empty")}</Text>
              </Paper>
            )}

            {folders && folders.length > 0 && (
              <Grid>
                {folders.map((folder) => (
                  <Grid.Col key={folder.id} span={{ base: 12, sm: 6, md: 4 }}>
                    <Card
                      withBorder
                      padding="md"
                      style={{ cursor: "pointer" }}
                      onClick={() =>
                        router.push(`/team/${teamIdStr}/folder/${folder.id}`)
                      }
                    >
                      <Group justify="space-between">
                        <Group gap="xs">
                          <TbFolder
                            size={20}
                            color={folder.color || "var(--mantine-color-blue-6)"}
                          />
                          <Text fw={500}>{folder.name}</Text>
                          {folder.myPermission === "READ" && (
                            <Badge size="xs" variant="light" color="gray">
                              {t("team.dashboard.folders.readOnly")}
                            </Badge>
                          )}
                        </Group>
                        {isTeamAdmin && (
                          <Menu position="bottom-end">
                            <Menu.Target>
                              <ActionIcon
                                variant="subtle"
                                color="gray"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <TbDotsVertical size={14} />
                              </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                              <Menu.Item
                                color="red"
                                leftSection={<TbTrash size={14} />}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteFolderConfirm("");
                                  setDeleteFolderTarget({ id: folder.id, name: folder.name });
                                }}
                              >
                                {t("team.dashboard.folders.delete")}
                              </Menu.Item>
                            </Menu.Dropdown>
                          </Menu>
                        )}
                      </Group>
                      {folder.description && (
                        <Text size="xs" c="dimmed" mt="xs">
                          {folder.description}
                        </Text>
                      )}
                      <Group gap="lg" mt="xs">
                        <Text size="xs" c="dimmed">
                          {t("team.dashboard.folders.sharesCount", { n: folder._count?.shares || 0 })}
                        </Text>
                      </Group>
                    </Card>
                  </Grid.Col>
                ))}
              </Grid>
            )}
          </Tabs.Panel>

          {/* Activity tab */}
          {canViewActivity && (
          <Tabs.Panel value="activity">
            {logsData && logsData.logs.length > 0 ? (
              isMobile ? (
              <Stack gap="sm">
                {logsData.logs.map((log) => (
                  <Card key={log.id} withBorder padding="sm">
                    <Group justify="space-between" mb={4}>
                      <Badge
                        size="sm"
                        variant="light"
                        color={
                          log.action === "DOWNLOAD" ? "green"
                            : log.action === "UPLOAD" ? "blue"
                            : log.action === "FOLDER_CREATE" || log.action === "FOLDER_DELETE" ? "violet"
                            : log.action === "INVITE" || log.action === "MEMBER_JOIN" ? "teal"
                            : log.action === "MEMBER_REMOVE" ? "red"
                            : log.action === "ROLE_CHANGE" ? "orange"
                            : log.action === "SHARE" ? "cyan"
                            : log.action === "SIGNATURE_REQUEST" ? "indigo"
                            : log.action === "SIGNATURE_SIGNED" ? "lime"
                            : log.action === "SIGNATURE_COMPLETE" ? "green"
                            : "gray"
                        }
                      >
                        {log.action === "SIGNATURE_REQUEST" ? t("team.dashboard.activity.signatureRequest")
                          : log.action === "SIGNATURE_SIGNED" ? t("team.dashboard.activity.signatureSigned")
                          : log.action === "SIGNATURE_COMPLETE" ? t("team.dashboard.activity.signatureComplete")
                          : log.action === "DOWNLOAD" ? t("team.dashboard.activity.download")
                          : log.action === "UPLOAD" ? t("team.dashboard.activity.upload")
                          : log.action === "FOLDER_CREATE" ? t("team.dashboard.activity.folderCreate")
                          : log.action === "FOLDER_DELETE" ? t("team.dashboard.activity.folderDelete")
                          : log.action === "INVITE" ? t("team.dashboard.activity.invite")
                          : log.action === "MEMBER_JOIN" ? t("team.dashboard.activity.memberJoin")
                          : log.action === "MEMBER_REMOVE" ? t("team.dashboard.activity.memberRemove")
                          : log.action === "ROLE_CHANGE" ? t("team.dashboard.activity.roleChange")
                          : log.action === "SHARE" ? t("team.dashboard.activity.share")
                          : log.action}
                      </Badge>
                      <Text size="xs" c="dimmed">
                        {new Date(log.createdAt).toLocaleString(intl.locale, { timeZone: "Europe/Paris" })}
                      </Text>
                    </Group>
                    <Text size="xs">{log.actorEmail}</Text>
                    {(log.fileName || log.folder?.name) && (
                      <Text size="xs" c="dimmed" lineClamp={1}>{log.fileName || log.folder?.name}</Text>
                    )}
                  </Card>
                ))}
              </Stack>
              ) : (
              <Paper withBorder>
                <Table striped style={{ tableLayout: "fixed" }}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th style={{ width: 170 }}>{t("team.dashboard.activity.headerAction")}</Table.Th>
                      <Table.Th style={{ width: 200 }}>{t("team.dashboard.activity.headerUser")}</Table.Th>
                      <Table.Th>{t("team.dashboard.activity.headerFileFolder")}</Table.Th>
                      <Table.Th style={{ width: 160 }}>{t("team.dashboard.activity.headerDate")}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {logsData.logs.map((log) => (
                      <Table.Tr key={log.id}>
                        <Table.Td>
                          <Badge
                            size="sm"
                            variant="light"
                            color={
                              log.action === "DOWNLOAD"
                                ? "green"
                                : log.action === "UPLOAD"
                                  ? "blue"
                                  : log.action === "FOLDER_CREATE" || log.action === "FOLDER_DELETE"
                                    ? "violet"
                                    : log.action === "INVITE" || log.action === "MEMBER_JOIN"
                                      ? "teal"
                                      : log.action === "MEMBER_REMOVE"
                                        ? "red"
                                        : log.action === "ROLE_CHANGE"
                                          ? "orange"
                                          : log.action === "SHARE"
                                            ? "cyan"
                                            : log.action === "SIGNATURE_REQUEST"
                                              ? "indigo"
                                              : log.action === "SIGNATURE_SIGNED"
                                                ? "lime"
                                                : log.action === "SIGNATURE_COMPLETE"
                                                  ? "green"
                                                  : "gray"
                            }
                          >
                            {log.action === "SIGNATURE_REQUEST"
                              ? t("team.dashboard.activity.signatureRequest")
                              : log.action === "SIGNATURE_SIGNED"
                                ? t("team.dashboard.activity.signatureSigned")
                                : log.action === "SIGNATURE_COMPLETE"
                                  ? t("team.dashboard.activity.signatureComplete")
                                  : log.action === "DOWNLOAD"
                                    ? t("team.dashboard.activity.download")
                                    : log.action === "UPLOAD"
                                      ? t("team.dashboard.activity.upload")
                                      : log.action === "FOLDER_CREATE"
                                        ? t("team.dashboard.activity.folderCreate")
                                        : log.action === "FOLDER_DELETE"
                                          ? t("team.dashboard.activity.folderDelete")
                                          : log.action === "INVITE"
                                            ? t("team.dashboard.activity.invite")
                                            : log.action === "MEMBER_JOIN"
                                              ? t("team.dashboard.activity.memberJoin")
                                              : log.action === "MEMBER_REMOVE"
                                                ? t("team.dashboard.activity.memberRemove")
                                                : log.action === "ROLE_CHANGE"
                                                  ? t("team.dashboard.activity.roleChange")
                                                  : log.action === "SHARE"
                                                    ? t("team.dashboard.activity.share")
                                                    : log.action}
                          </Badge>
                        </Table.Td>
                        <Table.Td style={{ overflow: "hidden" }}>
                          <Text size="sm" truncate>{log.actorEmail}</Text>
                        </Table.Td>
                        <Table.Td style={{ overflow: "hidden" }}>
                          <Text size="sm" truncate>
                            {log.fileName || log.folder?.name || "-"}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {new Date(log.createdAt).toLocaleString(intl.locale, { timeZone: "Europe/Paris" })}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Paper>
              )
            ) : (
              <Paper withBorder p="xl" ta="center">
                <Text c="dimmed">{t("team.dashboard.activity.empty")}</Text>
              </Paper>
            )}

            {/* Top downloaders */}
            {metrics?.activity.topDownloaders &&
              metrics.activity.topDownloaders.length > 0 && (
                <Paper withBorder p="md" mt="md">
                  <Title order={5} mb="sm">
                    {t("team.dashboard.activity.topDownloaders")}
                  </Title>
                  <Stack gap="xs">
                    {metrics.activity.topDownloaders.map((d, i) => (
                      <Group key={i} justify="space-between">
                        <Text size="sm">{d.email}</Text>
                        <Badge variant="light">{d.count} downloads</Badge>
                      </Group>
                    ))}
                  </Stack>
                </Paper>
              )}
          </Tabs.Panel>
          )}

          {/* Signatures tab */}
          {canViewSignatures && (
          <Tabs.Panel value="signatures">
            <Group justify="space-between" mb="md">
              <Text size="sm" c="dimmed">
                {teamSignatures?.length || 0} document(s) de signature
              </Text>
              <Button
                size="compact-sm"
                leftSection={<TbFileDescription size={14} />}
                onClick={() => router.push("/signing/new")}
              >
                {t("team.dashboard.buttons.newRequest")}
              </Button>
            </Group>

            {(!teamSignatures || teamSignatures.length === 0) ? (
              <Paper withBorder p="xl" ta="center">
                <Stack align="center" gap="md">
                  <TbFileDescription size={40} color="gray" />
                  <Text c="dimmed" size="sm">
                    {t("team.dashboard.signatures.empty")}
                  </Text>
                  <Button
                    size="compact-sm"
                    variant="light"
                    onClick={() => router.push("/signing/new")}
                  >
                    {t("team.dashboard.signatures.createRequest")}
                  </Button>
                </Stack>
              </Paper>
            ) : isMobile ? (
              <Stack gap="sm">
                {teamSignatures.map((doc) => {
                  const creator = (doc as any).creator;
                  const sigStatusColors: Record<string, string> = {
                    PENDING: "yellow", PARTIAL: "blue", COMPLETED: "green", CANCELLED: "gray", REJECTED: "red", AWAITING_FINALIZATION: "orange",
                  };
                  const sigStatusLabels: Record<string, string> = {
                    PENDING: t("team.dashboard.signatures.status.pending"), PARTIAL: t("team.dashboard.signatures.status.partial"), COMPLETED: t("team.dashboard.signatures.status.completed"), CANCELLED: t("team.dashboard.signatures.status.cancelled"), REJECTED: t("team.dashboard.signatures.status.rejected"), AWAITING_FINALIZATION: t("team.dashboard.signatures.status.awaitingFinalization"),
                  };
                  return (
                    <Card key={doc.id} withBorder padding="sm" style={{ cursor: "pointer" }} onClick={() => router.push(`/signing/${doc.id}`)}>
                      <Group justify="space-between" mb={4}>
                        <Group gap={6} style={{ flex: 1, minWidth: 0 }}>
                          <Text fw={600} size="sm" lineClamp={1} style={{ flex: 1 }}>
                            {doc.fileName || doc.title || t("team.dashboard.signatures.untitled")}
                          </Text>
                          {(doc as any).fileDeleted && (
                            <Tooltip label={t("team.dashboard.signatures.fileDeletedTooltip")}>
                              <Badge color="red" variant="light" size="xs" leftSection={<TbFileOff size={10} />}>
                                {t("team.dashboard.signatures.deleted")}
                              </Badge>
                            </Tooltip>
                          )}
                        </Group>
                        <Badge color={sigStatusColors[doc.status] || "gray"} variant="light" size="sm">
                          {sigStatusLabels[doc.status] || doc.status}
                        </Badge>
                      </Group>
                      <Text size="xs" c="dimmed" mb={4}>{t("team.dashboard.signatures.by")} : {creator?.username || creator?.email || "-"}</Text>
                      <Group gap={4} mb={4}>
                        {doc.recipients?.map((r) => (
                          <Badge key={r.id} size="xs" color={r.status === "SIGNED" ? "green" : r.status === "REJECTED" ? "red" : "gray"} variant="dot">
                            {r.name.split(" ")[0]}
                          </Badge>
                        ))}
                      </Group>
                      <Text size="xs" c="dimmed">{new Date(doc.createdAt).toLocaleDateString(intl.locale, { timeZone: "Europe/Paris" })}</Text>
                      {doc.status === "COMPLETED" && !(doc as any).fileDeleted && (
                        <Group mt="xs" onClick={(e) => e.stopPropagation()}>
                          <Button size="compact-xs" variant="light" color="green" onClick={async () => {
                            if ((doc as any).isE2EEncrypted) {
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
                            } catch { toast.error(t("team.dashboard.signatures.downloadError")); }
                          }}>
                            {t("team.dashboard.signatures.downloadBtn")}
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
                      <Table.Th>{t("team.dashboard.signatures.headerDocument")}</Table.Th>
                      <Table.Th style={{ width: 140 }}>{t("team.dashboard.signatures.headerCreator")}</Table.Th>
                      <Table.Th style={{ width: 130 }}>{t("team.dashboard.signatures.headerSigners")}</Table.Th>
                      <Table.Th style={{ width: 150 }}>{t("team.dashboard.signatures.headerStatus")}</Table.Th>
                      <Table.Th style={{ width: 100 }}>{t("team.dashboard.activity.headerDate")}</Table.Th>
                      <Table.Th style={{ width: 100 }}>{t("team.dashboard.signatures.headerActions")}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {teamSignatures.map((doc) => {
                      const creator = (doc as any).creator;
                      const sigStatusColors: Record<string, string> = {
                        PENDING: "yellow",
                        PARTIAL: "blue",
                        COMPLETED: "green",
                        CANCELLED: "gray",
                        REJECTED: "red",
                        AWAITING_FINALIZATION: "orange",
                      };
                      const sigStatusLabels: Record<string, string> = {
                        PENDING: t("team.dashboard.signatures.status.pending"),
                        PARTIAL: t("team.dashboard.signatures.status.partial"),
                        COMPLETED: t("team.dashboard.signatures.status.completed"),
                        CANCELLED: t("team.dashboard.signatures.status.cancelled"),
                        REJECTED: t("team.dashboard.signatures.status.rejected"),
                        AWAITING_FINALIZATION: t("team.dashboard.signatures.status.awaitingFinalization"),
                      };
                      return (
                        <Table.Tr
                          key={doc.id}
                          style={{ cursor: "pointer" }}
                          onClick={() => router.push(`/signing/${doc.id}`)}
                        >
                          <Table.Td style={{ overflow: "hidden" }}>
                            <Group gap={6} wrap="nowrap">
                              <Text fw={500} truncate style={{ flex: 1 }}>
                                {doc.fileName || doc.title || t("team.dashboard.signatures.untitled")}
                              </Text>
                              {(doc as any).fileDeleted && (
                                <Tooltip label={t("team.dashboard.signatures.fileDeletedTooltip")}>
                                  <Badge color="red" variant="light" size="xs" leftSection={<TbFileOff size={10} />}>
                                    {t("team.dashboard.signatures.deleted")}
                                  </Badge>
                                </Tooltip>
                              )}
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm">
                              {creator?.username || creator?.email || "-"}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Group gap={4}>
                              {doc.recipients?.map((r) => (
                                <Tooltip key={r.id} label={`${r.name} (${r.email})`}>
                                  <Badge
                                    size="xs"
                                    color={
                                      r.status === "SIGNED"
                                        ? "green"
                                        : r.status === "REJECTED"
                                          ? "red"
                                          : "gray"
                                    }
                                    variant="dot"
                                  >
                                    {r.name.split(" ")[0]}
                                  </Badge>
                                </Tooltip>
                              ))}
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            <Badge
                              color={sigStatusColors[doc.status] || "gray"}
                              variant="light"
                            >
                              {sigStatusLabels[doc.status] || doc.status}
                            </Badge>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm" c="dimmed">
                              {new Date(doc.createdAt).toLocaleDateString(intl.locale, { timeZone: "Europe/Paris" })}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Group gap={4} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                              <Tooltip label={t("team.dashboard.signatures.viewDetails")}>
                                <ActionIcon
                                  variant="light"
                                  color="blue"
                                  size="sm"
                                  onClick={() => router.push(`/signing/${doc.id}`)}
                                >
                                  <TbFileDescription size={14} />
                                </ActionIcon>
                              </Tooltip>
                              {doc.status === "COMPLETED" && !(doc as any).fileDeleted && (
                                <Tooltip label={t("team.dashboard.signatures.downloadSignedPdf")}>
                                  <ActionIcon
                                    variant="light"
                                    color="green"
                                    size="sm"
                                    onClick={async () => {
                                      if ((doc as any).isE2EEncrypted) {
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
                                        toast.error(t("team.dashboard.signatures.downloadError"));
                                      }
                                    }}
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
            )}
          </Tabs.Panel>
          )}

        </Tabs>
      </Container>

      {/* Rotation confirmation modal */}
      <Modal
        opened={rotateOpened}
        onClose={() => { if (!rotating) closeRotate(); }}
        closeOnClickOutside={!rotating}
        closeOnEscape={!rotating}
        withCloseButton={!rotating}
        title={t("team.dashboard.modals.rotation.title")}
        size="md"
      >
        <Stack gap="md">
          {!rotating && !rotateProgress && (
            <>
              <Alert color="orange" icon={<TbKey size={16} />}>
                {t("team.dashboard.modals.rotation.warning")}
              </Alert>
              <Text size="sm" c="dimmed">
                {t("team.dashboard.modals.rotation.description")}
              </Text>
              <Group justify="flex-end">
                <Button variant="subtle" onClick={closeRotate}>{t("common.cancel")}</Button>
                <Button color="orange" onClick={handleRotateKey} leftSection={<TbKey size={14} />}>
                  {t("team.dashboard.modals.rotation.startBtn")}
                </Button>
              </Group>
            </>
          )}
          {rotating && rotateProgress && (
            <>
              <Text size="sm" fw={500}>
                {t("team.dashboard.modals.rotation.progress", { done: rotateProgress.filesDone, total: rotateProgress.filesTotal })}
              </Text>
              {rotateProgress.currentFile && (
                <Text size="xs" c="dimmed" lineClamp={1}>{rotateProgress.currentFile}</Text>
              )}
              <Progress
                value={rotateProgress.filesTotal > 0
                  ? (rotateProgress.filesDone / rotateProgress.filesTotal) * 100
                  : 0}
                animated
                size="lg"
              />
              {rotateProgress.filesFailed > 0 && (
                <Text size="xs" c="red">{t("team.dashboard.modals.rotation.failures", { n: rotateProgress.filesFailed })}</Text>
              )}
              <Button
                variant="subtle"
                color="red"
                size="compact-sm"
                loading={cancellingRotation}
                onClick={() => {
                  setCancellingRotation(true);
                  rotateAbort?.abort();
                }}
              >
                {t("common.cancel")}
              </Button>
            </>
          )}
          {rotating && !rotateProgress && (
            <Group justify="center" py="md">
              <Loader size="sm" />
              <Text size="sm">{t("team.dashboard.modals.rotation.preparing")}</Text>
            </Group>
          )}
        </Stack>
      </Modal>

      {/* E2E init: distribution links modal */}
      <Modal
        opened={initLinksOpened}
        onClose={closeInitLinks}
        title={t("team.dashboard.modals.initLinks.title")}
        size="lg"
      >
        <Stack gap="md">
          <Alert color="green" icon={<TbLockOpen size={16} />}>
            {t("team.dashboard.modals.initLinks.description")}
          </Alert>
          <Alert color="orange" icon={<TbLock size={16} />}>
            {t("team.dashboard.modals.initLinks.warning")}
          </Alert>
          {allMemberLinks.map((m) => (
            <Paper key={m.memberId} withBorder p="sm">
              <Text size="sm" fw={500} mb={4}>
                {m.name} <Text span c="dimmed" size="xs">({m.email})</Text>
              </Text>
              <TextInput
                readOnly
                size="xs"
                value={m.link}
                rightSection={
                  <CopyButton value={m.link}>
                    {({ copied, copy }) => (
                      <ActionIcon color={copied ? "green" : "blue"} onClick={copy} size="sm">
                        {copied ? <TbCheck size={12} /> : <TbCopy size={12} />}
                      </ActionIcon>
                    )}
                  </CopyButton>
                }
              />
            </Paper>
          ))}
          <Button onClick={closeInitLinks} mt="sm">{t("team.dashboard.modals.initLinks.doneBtn")}</Button>
        </Stack>
      </Modal>

      {/* Invite modal */}
      <Modal opened={inviteOpened} onClose={closeInvite} title={t("team.dashboard.modals.invite.title")}>
        <Stack gap="md">
          <Alert variant="light" color="blue" mb="xs">
            {t("team.dashboard.modals.invite.description")}
          </Alert>
          <TextInput
            label={t("team.dashboard.modals.invite.emailLabel")}
            placeholder="collaborateur@example.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.currentTarget.value)}
            required
          />
          <Select
            label={t("team.dashboard.modals.invite.roleLabel")}
            data={[
              { value: "MEMBER", label: t("team.dashboard.roles.member") },
              { value: "ADMIN", label: t("team.dashboard.roles.admin") },
            ]}
            value={inviteRole}
            onChange={(val) => setInviteRole(val || "MEMBER")}
          />
          <Group justify="flex-end">
            <Button variant="subtle" onClick={closeInvite}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => inviteMutation.mutate()}
              loading={inviteMutation.isPending}
              disabled={!inviteEmail}
              leftSection={<TbMail size={16} />}
            >
              {t("team.dashboard.modals.invite.sendBtn")}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Create folder modal */}
      <Modal opened={folderOpened} onClose={closeFolder} title={t("team.dashboard.modals.createFolder.title")}>
        <Stack gap="md">
          <TextInput
            label={t("team.dashboard.modals.createFolder.nameLabel")}
            placeholder={t("team.dashboard.modals.createFolder.namePlaceholder")}
            value={folderName}
            onChange={(e) => setFolderName(e.currentTarget.value)}
            required
          />
          <Group justify="flex-end">
            <Button variant="subtle" onClick={closeFolder}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => createFolderMutation.mutate()}
              loading={createFolderMutation.isPending}
              disabled={!folderName}
            >
              {t("team.dashboard.modals.createFolder.createBtn")}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Modal de confirmation de suppression de dossier */}
      <Modal
        opened={!!deleteFolderTarget}
        onClose={() => setDeleteFolderTarget(null)}
        title={
          <Group gap="xs">
            <TbTrash size={20} color="var(--mantine-color-red-6)" />
            <Text fw={700} c="red">
              {t("team.dashboard.modals.deleteFolder.title")}
            </Text>
          </Group>
        }
        centered
      >
        {deleteFolderTarget && (
          <Stack gap="md">
            <Alert color="red" variant="light">
              {t("team.dashboard.modals.deleteFolder.warning", { name: deleteFolderTarget.name })}
              <ul style={{ margin: "8px 0 0 0", paddingLeft: 16 }}>
                <li>{t("team.dashboard.modals.deleteFolder.listFiles")}</li>
                <li>{t("team.dashboard.modals.deleteFolder.listShares")}</li>
                <li>{t("team.dashboard.modals.deleteFolder.listPermissions")}</li>
              </ul>
            </Alert>

            <Text size="sm" fw={500}>
              {t("team.dashboard.modals.deleteFolder.confirmPrompt")}{" "}
              <Text span ff="monospace" fw={700} c="red">
                {deleteFolderTarget.name}
              </Text>
            </Text>

            <TextInput
              placeholder={deleteFolderTarget.name}
              value={deleteFolderConfirm}
              onChange={(e) => setDeleteFolderConfirm(e.currentTarget.value)}
              error={
                deleteFolderConfirm.length > 0 &&
                deleteFolderConfirm !== deleteFolderTarget.name
                  ? t("team.dashboard.modals.deleteFolder.nameMismatch")
                  : undefined
              }
              styles={{
                input: { borderColor: "var(--mantine-color-red-4)" },
              }}
            />

            <Group justify="flex-end" gap="sm">
              <Button
                variant="default"
                onClick={() => setDeleteFolderTarget(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                color="red"
                leftSection={<TbTrash size={16} />}
                disabled={deleteFolderConfirm !== deleteFolderTarget.name}
                loading={deleteFolderMutation.isPending}
                onClick={() =>
                  deleteFolderMutation.mutate({
                    folderId: deleteFolderTarget.id,
                    confirmationName: deleteFolderConfirm,
                  })
                }
              >
                {t("team.dashboard.modals.deleteFolder.deleteBtn")}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      {/* Modal de confirmation de retrait d'un membre */}
      <Modal
        opened={!!removeMemberTarget}
        onClose={() => setRemoveMemberTarget(null)}
        title={
          <Group gap="xs">
            <TbTrash size={20} color="var(--mantine-color-red-6)" />
            <Text fw={700} c="red">
              {t("team.dashboard.modals.removeMember.title")}
            </Text>
          </Group>
        }
        centered
      >
        {removeMemberTarget && (
          <Stack gap="md">
            <Text size="sm">
              {t("team.dashboard.modals.removeMember.confirm", { name: removeMemberTarget.username || removeMemberTarget.email, email: removeMemberTarget.email })}
            </Text>
            <Text size="xs" c="dimmed">
              {t("team.dashboard.modals.removeMember.warning")}
            </Text>
            <Group justify="flex-end" gap="sm">
              <Button
                variant="default"
                onClick={() => setRemoveMemberTarget(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                color="red"
                leftSection={<TbTrash size={16} />}
                loading={removeMemberMutation.isPending}
                onClick={() =>
                  removeMemberMutation.mutate(removeMemberTarget.id)
                }
              >
                {t("team.dashboard.modals.removeMember.removeBtn")}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      {/* Modal: secure invitation link with team key */}
      <Modal
        opened={!!secureInviteLink}
        onClose={() => setSecureInviteLink(null)}
        title={t("team.dashboard.modals.secureLink.title")}
        size="lg"
      >
        <Stack gap="md">
          <Alert color="blue" variant="light">
            {t("team.dashboard.modals.secureLink.description")}
          </Alert>
          <TextInput
            value={secureInviteLink || ""}
            readOnly
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <Button
            onClick={() => {
              navigator.clipboard.writeText(secureInviteLink!);
              toast.success(t("team.dashboard.modals.secureLink.copied"));
            }}
          >
            {t("team.dashboard.modals.secureLink.copyBtn")}
          </Button>
        </Stack>
      </Modal>
    </>
  );
};

export default TeamDashboard;
