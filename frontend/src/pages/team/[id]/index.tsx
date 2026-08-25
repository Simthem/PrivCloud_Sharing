import "@mantine/core/styles/RingProgress.css";
import "@mantine/core/styles/Tabs.css";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/router";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Collapse,
  Container,
  Divider,
  Grid,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  Pagination,
  Progress,
  RingProgress,
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
  TbShare,
  TbShieldCheck,
  TbTrash,
  TbUsers,
  TbUserDown,
  TbUserPlus,
  TbFileDescription,
  TbFileOff,
  TbSearch,
  TbAdjustmentsHorizontal,
  TbChevronRight,
  TbX,
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
  canUnwrapWithMasterKey,
  isStaleTeamKeyError,
} from "../../../utils/crypto.util";
import {
  reencryptTeam,
  TeamReencryptProgress,
} from "../../../utils/reencrypt.util";
import { getTeamShares } from "../../../services/crypto.service";
import toast from "../../../utils/toast.util";
import useUser from "../../../hooks/user.hook";
import useTranslate from "../../../hooks/useTranslate.hook";
import {
  buildTeamSearchResults,
  TeamSearchKind,
} from "../../../utils/teamSearch.util";
import searchStyles from "./TeamSearchPanel.module.css";

const signatureStatusTranslationKeys: Record<string, string> = {
  PENDING: "team.dashboard.signatures.status.pending",
  PARTIAL: "team.dashboard.signatures.status.partial",
  COMPLETED: "team.dashboard.signatures.status.completed",
  CANCELLED: "team.dashboard.signatures.status.cancelled",
  REJECTED: "team.dashboard.signatures.status.rejected",
  AWAITING_FINALIZATION:
    "team.dashboard.signatures.status.awaitingFinalization",
};

const formatBytes = (bytes: number) => {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
};

const VALID_TABS = [
  "members",
  "folders",
  "search",
  "shares",
  "activity",
  "signatures",
] as const;

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

  // Authentication is the only global gate in the public OSS edition.
  useEffect(() => {
    if (user.user === null) {
      router.replace(`/auth/signIn?redirect=/team/${teamIdStr}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.user]);

  const [inviteEmail, setInviteEmail] = useState("");
  const [signaturePage, setSignaturePage] = useState(1);
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
  const [myWrappedTeamKey, setMyWrappedTeamKey] = useState<
    string | null | undefined
  >(undefined); // undefined=loading, null=none
  const [teamKeyStale, setTeamKeyStale] = useState(false);
  const [clearingStaleKey, setClearingStaleKey] = useState(false);
  const [e2eInitializing, setE2eInitializing] = useState(false);
  const [memberKeyLinks, setMemberKeyLinks] = useState<Record<string, string>>(
    {},
  ); // memberId -> secure link
  const [initLinksOpened, { open: openInitLinks, close: closeInitLinks }] =
    useDisclosure(false);
  const [allMemberLinks, setAllMemberLinks] = useState<
    { memberId: string; name: string; email: string; link: string }[]
  >([]);
  const [rotateOpened, { open: openRotate, close: closeRotate }] =
    useDisclosure(false);
  const [rotateProgress, setRotateProgress] =
    useState<TeamReencryptProgress | null>(null);
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
          const fragmentVersion = Number.parseInt(
            new URLSearchParams(window.location.hash.slice(1)).get("version") ||
              "",
            10,
          );
          const teamKey = await importKeyFromBase64(fragmentTeamKey);
          const masterKey = await importKeyFromBase64(userKeyB64);
          const wrapped = await wrapReverseShareKey(teamKey, masterKey);
          await teamService.setTeamKey(
            teamIdStr,
            wrapped,
            Number.isFinite(fragmentVersion) ? fragmentVersion : undefined,
          );
          if (!cancelled) {
            setMyWrappedTeamKey(wrapped);
            setTeamKeyStale(false);
            queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
            queryClient.invalidateQueries({
              queryKey: ["team.keyRotation", teamIdStr],
            });
            toast.success(t("team.dashboard.e2e.keyReceivedSuccess"));
            // Clean fragment from URL
            router.replace(router.asPath.split("#")[0], undefined, {
              shallow: true,
            });
          }
          return;
        }
        // 2. Load existing key from server
        const { wrappedTeamKey } = await teamService.getTeamKey(teamIdStr);
        let stale = false;
        if (wrappedTeamKey && userKeyB64) {
          const masterKey = await importKeyFromBase64(userKeyB64);
          stale = !(await canUnwrapWithMasterKey(wrappedTeamKey, masterKey));
        }
        if (!cancelled) {
          setMyWrappedTeamKey(wrappedTeamKey);
          setTeamKeyStale(stale);
        }
      } catch {
        if (!cancelled) setMyWrappedTeamKey(null);
      }
    })();
    return () => {
      cancelled = true;
    };
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
      await teamService.setTeamKey(
        teamIdStr,
        wrapped,
        keyRotationStatus?.policy.currentVersion ?? team?.keyVersion,
      );
      setMyWrappedTeamKey(wrapped);
      setTeamKeyStale(false);

      // Automatically generate sharing links for all existing members who don't have the key
      const teamKeyB64 = await exportKeyToBase64(teamKey);
      const otherMembers = (team?.members ?? []).filter(
        (m: any) => !m.hasTeamKey && m.user?.id !== user.user?.id,
      );
      const links = otherMembers.map((m: any) => ({
        memberId: m.id,
        name:
          m.user?.username || m.user?.email || t("team.dashboard.roles.member"),
        email: m.user?.email || "",
        link: `${window.location.origin}/team/${teamIdStr}#teamKey=${teamKeyB64}&version=${team?.keyVersion || 1}`,
      }));
      // Also store them in the per-member state for the table
      const perMember: Record<string, string> = {};
      links.forEach((l) => {
        perMember[l.memberId] = l.link;
      });
      setMemberKeyLinks((prev) => ({ ...prev, ...perMember }));

      if (links.length > 0) {
        setAllMemberLinks(links);
        openInitLinks();
      } else {
        toast.success(t("team.dashboard.e2e.activatedSoleMember"));
      }
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
      queryClient.invalidateQueries({
        queryKey: ["team.keyRotation", teamIdStr],
      });
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
      const link = `${window.location.origin}/team/${teamIdStr}#teamKey=${teamKeyB64}&version=${keyRotationStatus?.policy.currentVersion || team?.keyVersion || 1}`;
      setMemberKeyLinks((prev) => ({ ...prev, [memberId]: link }));
    } catch (e) {
      if (isStaleTeamKeyError(e)) {
        setTeamKeyStale(true);
        toast.error(t("team.dashboard.e2e.staleKey.toast"));
      } else {
        toast.error(t("team.dashboard.e2e.shareLinkError"));
      }
      console.error(e);
    }
  };

  const handleClearStaleKey = async () => {
    setClearingStaleKey(true);
    try {
      await teamService.clearTeamKey(teamIdStr);
      setMyWrappedTeamKey(null);
      setTeamKeyStale(false);
      toast.success(t("team.dashboard.e2e.staleKey.cleared"));
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
      queryClient.invalidateQueries({
        queryKey: ["team.keyRotation", teamIdStr],
      });
    } catch (e) {
      toast.error(t("team.dashboard.e2e.staleKey.clearError"));
      console.error(e);
    } finally {
      setClearingStaleKey(false);
    }
  };

  // Rotate K_team through a resumable server-side orchestration session.
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
    let currentRotationId = keyRotationStatus?.activeRotation?.id || null;
    try {
      const masterKey = await importKeyFromBase64(userKeyB64);
      const oldTeamKey = await unwrapReverseShareKey(
        myWrappedTeamKey,
        masterKey,
      );
      const oldTeamKeyB64 = await exportKeyToBase64(oldTeamKey);

      const activeRotation = keyRotationStatus?.activeRotation;
      let rotationId: string;
      let rotationVersion: number;
      let completedFileIds: string[] = [];
      let newTeamKey: CryptoKey;

      if (activeRotation) {
        if (
          !activeRotation.canResume ||
          !activeRotation.pendingWrappedTeamKey
        ) {
          throw new Error(
            "Cette rotation doit être reprise par son initiateur",
          );
        }
        newTeamKey = await unwrapReverseShareKey(
          activeRotation.pendingWrappedTeamKey,
          masterKey,
        );
        rotationId = activeRotation.id;
        currentRotationId = rotationId;
        rotationVersion = activeRotation.toVersion;
        completedFileIds = activeRotation.completedFileIds;
      } else {
        newTeamKey = await generateEncryptionKey();
        const newWrapped = await wrapReverseShareKey(newTeamKey, masterKey);
        const session = await teamService.startKeyRotation(teamIdStr, {
          newWrappedTeamKey: newWrapped,
          reason: keyRotationStatus?.policy.isDue ? "POLICY" : "MANUAL",
        });
        rotationId = session.id;
        currentRotationId = rotationId;
        rotationVersion = session.toVersion;
      }
      const newTeamKeyB64 = await exportKeyToBase64(newTeamKey);

      const result = await reencryptTeam(
        teamIdStr,
        oldTeamKeyB64,
        newTeamKeyB64,
        (p) => setRotateProgress(p),
        ac.signal,
        {
          rotationId,
          completedFileIds,
          onSkippedFile: async (fileId) => {
            await teamService.updateKeyRotationProgress(teamIdStr, rotationId, {
              completedFileId: fileId,
              status: "REENCRYPTING",
            });
          },
        },
      );

      if (result.filesFailed > 0) {
        await teamService.updateKeyRotationProgress(teamIdStr, rotationId, {
          failedFiles: result.filesFailed,
          status: "PAUSED",
          errorMessage: result.failedDetails.join(" | ").slice(0, 2000),
        });
        toast.error(
          t("team.dashboard.e2e.rotatePartialFail", { n: result.filesFailed }),
        );
        setRotating(false);
        queryClient.invalidateQueries({
          queryKey: ["team.keyRotation", teamIdStr],
        });
        return;
      }

      const newWrapped = await wrapReverseShareKey(newTeamKey, masterKey);
      await teamService.updateKeyRotationProgress(teamIdStr, rotationId, {
        failedFiles: 0,
        status: "REENCRYPTING",
      });
      await teamService.completeKeyRotation(teamIdStr, rotationId);
      setMyWrappedTeamKey(newWrapped);

      // Phase 3: generate distribution links for all OTHER active members
      const otherMembers = (team?.members ?? []).filter(
        (m: any) => m.isActive && m.user?.id !== user.user?.id,
      );
      const links = otherMembers.map((m: any) => ({
        memberId: m.id,
        name:
          m.user?.username || m.user?.email || t("team.dashboard.roles.member"),
        email: m.user?.email || "",
        link: `${window.location.origin}/team/${teamIdStr}#teamKey=${newTeamKeyB64}&version=${rotationVersion}`,
      }));
      const perMember: Record<string, string> = {};
      links.forEach((l) => {
        perMember[l.memberId] = l.link;
      });
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
      queryClient.invalidateQueries({
        queryKey: ["team.keyRotation", teamIdStr],
      });
    } catch (e: any) {
      if (e?.message?.includes("annulé")) {
        toast.error(t("team.dashboard.e2e.rotateCancelled"));
      } else if (isStaleTeamKeyError(e)) {
        setTeamKeyStale(true);
        closeRotate();
        toast.error(t("team.dashboard.e2e.staleKey.toast"));
        console.error(e);
      } else {
        toast.error(t("team.dashboard.e2e.rotateError"));
        console.error(e);
      }
      if (currentRotationId) {
        teamService
          .updateKeyRotationProgress(teamIdStr, currentRotationId, {
            status: "PAUSED",
            errorMessage: e?.message || "Rotation interrompue",
          })
          .catch(() => undefined);
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
    staleTime: 30_000,
    refetchInterval: initLinksOpened ? 10_000 : false,
  });

  const { data: keyRotationStatus } = useQuery({
    queryKey: ["team.keyRotation", teamIdStr],
    queryFn: () => teamService.getKeyRotationStatus(teamIdStr),
    enabled: !!teamIdStr,
    staleTime: 30_000,
    refetchInterval: rotating ? 5000 : false,
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

  const anotherMemberHoldsKey = useMemo(
    () =>
      (team?.members ?? []).some(
        (member: any) =>
          member.isActive &&
          member.user?.id !== user.user?.id &&
          member.keyStatus === "CURRENT",
      ),
    [team, user.user],
  );

  const activeTab = useMemo(() => {
    if (!rawTab || !(VALID_TABS as readonly string[]).includes(rawTab))
      return "members";
    if (rawTab === "activity" && !canViewActivity) return "members";
    if (rawTab === "signatures" && !canViewSignatures) return "members";
    return rawTab;
  }, [rawTab, canViewActivity, canViewSignatures]);

  // Fetch metrics
  const { data: metrics } = useQuery({
    queryKey: ["team.metrics", teamIdStr],
    queryFn: () => teamService.getMetrics(teamIdStr),
    enabled: !!teamIdStr,
    staleTime: 30_000,
  });
  const storagePercentage = metrics?.storage.percentage ?? 0;
  const storageProgressValue = Math.min(Math.max(storagePercentage, 0), 100);
  const storageColor =
    storagePercentage > 90 ? "red" : storagePercentage > 70 ? "yellow" : "blue";
  const quotaStorageUsed = metrics?.storage.used ?? 0;
  const folderStorageUsed = metrics?.storage.folderUsed ?? quotaStorageUsed;
  const showStorageBreakdown =
    !!metrics && folderStorageUsed !== quotaStorageUsed;

  // Fetch folders
  const { data: folders } = useQuery({
    queryKey: ["team.folders", teamIdStr],
    queryFn: () => teamService.getFolders(teamIdStr),
    enabled: !!teamIdStr && activeTab === "folders",
    staleTime: 30_000,
  });

  // Fetch access logs (admin/owner or members with canViewActivity)
  const { data: logsData } = useQuery({
    queryKey: ["team.logs", teamIdStr],
    queryFn: () => teamService.getAccessLogs(teamIdStr, { limit: 20 }),
    enabled: !!teamIdStr && canViewActivity && activeTab === "activity",
    staleTime: 30_000,
  });

  // Fetch team signature documents
  const { data: teamSignaturesData } = useQuery({
    queryKey: ["team.signatures", teamIdStr, signaturePage],
    queryFn: () =>
      signingService.getTeamDocuments(teamIdStr, {
        page: signaturePage,
        limit: 50,
      }),
    enabled: !!teamIdStr && canViewSignatures && activeTab === "signatures",
    staleTime: 30_000,
  });
  const teamSignatures = teamSignaturesData?.documents;

  // Split active vs deleted team signatures
  const activeTeamSignatures =
    teamSignatures?.filter((d) => !(d as any).fileDeleted) ?? [];
  const deletedTeamSignatures =
    teamSignatures?.filter((d) => (d as any).fileDeleted) ?? [];

  // Mutations
  const inviteMutation = useMutation({
    mutationFn: () =>
      teamService.inviteMember(teamIdStr, {
        email: inviteEmail,
        role: inviteRole,
      }),
    onSuccess: async (data) => {
      toast.success(
        t("team.dashboard.invite.sentSuccess", { email: inviteEmail }),
      );
      setInviteEmail("");

      // Build secure invitation link with team key in fragment (use already-loaded key)
      try {
        const userKeyB64 = getUserKey();
        if (userKeyB64 && data.invitationToken && myWrappedTeamKey) {
          const masterKey = await importKeyFromBase64(userKeyB64);
          const teamKey = await unwrapReverseShareKey(
            myWrappedTeamKey,
            masterKey,
          );
          const teamKeyB64 = await exportKeyToBase64(teamKey);
          const baseUrl = window.location.origin;
          const link = `${baseUrl}/team/invite/${data.invitationToken}#teamKey=${teamKeyB64}&version=${keyRotationStatus?.policy.currentVersion || team?.keyVersion || 1}`;
          setSecureInviteLink(link);
        } else if (!myWrappedTeamKey) {
          toast.error(t("team.dashboard.e2e.noKeyForInvite"));
        }
      } catch (e) {
        if (isStaleTeamKeyError(e)) {
          setTeamKeyStale(true);
          toast.error(t("team.dashboard.e2e.staleKey.toast"));
        }
        console.warn("[E2E] Could not build secure invite link:", e);
      }

      closeInvite();
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message || t("team.dashboard.invite.error"),
      ),
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
      toast.error(
        err?.response?.data?.message ||
          t("team.dashboard.members.roleChangeError"),
      ),
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
      toast.error(
        err?.response?.data?.message ||
          t("team.dashboard.members.permissionsError"),
      ),
  });

  const createFolderMutation = useMutation({
    mutationFn: () => teamService.createFolder(teamIdStr, { name: folderName }),
    onSuccess: () => {
      toast.success(t("team.dashboard.folders.createdSuccess"));
      setFolderName("");
      closeFolder();
      queryClient.invalidateQueries({ queryKey: ["team.folders", teamIdStr] });
      queryClient.invalidateQueries({ queryKey: ["team.logs", teamIdStr] });
      queryClient.invalidateQueries({
        queryKey: ["teams", "writable-folders"],
      });
    },
    onError: () => toast.error(t("team.dashboard.folders.createError")),
  });

  const deleteFolderMutation = useMutation({
    mutationFn: ({
      folderId,
      confirmationName,
    }: {
      folderId: string;
      confirmationName: string;
    }) => teamService.deleteFolder(teamIdStr, folderId, confirmationName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team.folders", teamIdStr] });
      queryClient.invalidateQueries({
        queryKey: ["teams", "writable-folders"],
      });
      toast.success(t("team.dashboard.folders.deletedSuccess"));
      setDeleteFolderTarget(null);
      setDeleteFolderConfirm("");
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message || t("team.dashboard.folders.deleteError"),
      ),
  });

  if (teamLoading || !teamIdStr) {
    return (
      <Container size="lg" px={0}>
        <Box ta="center" py="xl">
          <Loader size="lg" />
        </Box>
      </Container>
    );
  }

  if (!team) {
    return (
      <Container size="lg" px={0}>
        <Alert color="red">{t("team.dashboard.error.notFound")}</Alert>
      </Container>
    );
  }

  return (
    <>
      <Meta title={t("team.dashboard.meta.title", { name: team.name })} />
      <Container size="lg" mb="xl" px={0}>
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
          <Grid mb="lg" gutter={isMobile ? "xs" : "md"}>
            <Grid.Col span={{ base: 6, sm: 6, md: 3 }}>
              <Card
                withBorder
                padding={isMobile ? "sm" : "md"}
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <Text
                  size="xs"
                  c="dimmed"
                  tt="uppercase"
                  fw={700}
                  lineClamp={1}
                >
                  {t("team.dashboard.metrics.storage")}
                </Text>
                <Stack
                  justify="space-between"
                  align={isMobile ? "center" : "stretch"}
                  style={{ flex: 1, marginTop: 8 }}
                >
                  {isMobile ? (
                    <>
                      <RingProgress
                        size={70}
                        thickness={6}
                        sections={[
                          {
                            value: storageProgressValue,
                            color: storageColor,
                          },
                        ]}
                        label={
                          <Text ta="center" fw={700} size="sm">
                            {storagePercentage}%
                          </Text>
                        }
                      />
                      {showStorageBreakdown ? (
                        <Stack gap={2} align="center">
                          <Text size="xs" c="dimmed" ta="center">
                            {t("team.dashboard.metrics.folderStorage", {
                              size: formatBytes(folderStorageUsed),
                            })}
                          </Text>
                          <Text size="xs" c="dimmed" ta="center">
                            {t("team.dashboard.metrics.quotaStorage", {
                              used: formatBytes(quotaStorageUsed),
                              limit: formatBytes(metrics.storage.limit),
                            })}
                          </Text>
                        </Stack>
                      ) : (
                        <Text size="xs" c="dimmed" ta="center">
                          {formatBytes(quotaStorageUsed)} /{" "}
                          {formatBytes(metrics.storage.limit)}
                        </Text>
                      )}
                    </>
                  ) : (
                    <>
                      <Group justify="space-between">
                        <Text fw={700} size="xl">
                          {storagePercentage}%
                        </Text>
                        <RingProgress
                          size={50}
                          thickness={5}
                          sections={[
                            {
                              value: storageProgressValue,
                              color: storageColor,
                            },
                          ]}
                        />
                      </Group>
                      {showStorageBreakdown ? (
                        <Stack gap={2}>
                          <Text size="xs" c="dimmed">
                            {t("team.dashboard.metrics.folderStorage", {
                              size: formatBytes(folderStorageUsed),
                            })}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {t("team.dashboard.metrics.quotaStorage", {
                              used: formatBytes(quotaStorageUsed),
                              limit: formatBytes(metrics.storage.limit),
                            })}
                          </Text>
                        </Stack>
                      ) : (
                        <Text size="xs" c="dimmed">
                          {formatBytes(quotaStorageUsed)} /{" "}
                          {formatBytes(metrics.storage.limit)}
                        </Text>
                      )}
                    </>
                  )}
                </Stack>
              </Card>
            </Grid.Col>

            <Grid.Col span={{ base: 6, sm: 6, md: 3 }}>
              <Card
                withBorder
                padding={isMobile ? "sm" : "md"}
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <Text
                  size="xs"
                  c="dimmed"
                  tt="uppercase"
                  fw={700}
                  lineClamp={1}
                >
                  {t("team.dashboard.metrics.members")}
                </Text>
                <Stack
                  justify="space-between"
                  style={{ flex: 1, marginTop: 8 }}
                >
                  <Text fw={700} size={isMobile ? "lg" : "xl"}>
                    {metrics.team.membersCount} / {metrics.team.maxMembers}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={2}>
                    {t("team.dashboard.metrics.membersRemaining", {
                      n: metrics.team.maxMembers - metrics.team.membersCount,
                    })}
                  </Text>
                </Stack>
              </Card>
            </Grid.Col>

            <Grid.Col span={{ base: 6, sm: 6, md: 3 }}>
              <Card
                withBorder
                padding={isMobile ? "sm" : "md"}
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <Text
                  size="xs"
                  c="dimmed"
                  tt="uppercase"
                  fw={700}
                  lineClamp={1}
                >
                  {t("team.dashboard.metrics.downloads30d")}
                </Text>
                <Stack
                  justify="space-between"
                  style={{ flex: 1, marginTop: 8 }}
                >
                  <Text fw={700} size={isMobile ? "lg" : "xl"}>
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

            <Grid.Col span={{ base: 6, sm: 6, md: 3 }}>
              <Card
                withBorder
                padding={isMobile ? "sm" : "md"}
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <Text
                  size="xs"
                  c="dimmed"
                  tt="uppercase"
                  fw={700}
                  lineClamp={1}
                >
                  {t("team.dashboard.metrics.files")}
                </Text>
                <Stack
                  justify="space-between"
                  style={{ flex: 1, marginTop: 8 }}
                >
                  <Text fw={700} size={isMobile ? "lg" : "xl"}>
                    {metrics.activity.totalFiles}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={2}>
                    {t("team.dashboard.metrics.foldersCount", {
                      n: metrics.team.foldersCount,
                    })}
                  </Text>
                </Stack>
              </Card>
            </Grid.Col>
          </Grid>
        )}

        {/* E2E banner */}
        {isTeamAdmin && keyRotationStatus?.activeRotation && (
          <Alert
            icon={<TbKey size={18} />}
            color={
              keyRotationStatus.activeRotation.canResume ? "orange" : "blue"
            }
            mb="md"
            title={t("team.dashboard.rotation.inProgress")}
          >
            <Group justify="space-between" align="center" wrap="wrap">
              <Box style={{ flex: 1, minWidth: 220 }}>
                <Text size="sm" mb={6}>
                  {t("team.dashboard.rotation.progress", {
                    done: keyRotationStatus.activeRotation.processedFiles,
                    total: keyRotationStatus.activeRotation.totalFiles,
                  })}
                </Text>
                <Progress
                  value={
                    keyRotationStatus.activeRotation.totalFiles > 0
                      ? (keyRotationStatus.activeRotation.processedFiles /
                          keyRotationStatus.activeRotation.totalFiles) *
                        100
                      : 100
                  }
                  size="sm"
                />
              </Box>
              {keyRotationStatus.activeRotation.canResume && (
                <Button
                  size="compact-sm"
                  color="orange"
                  variant="light"
                  leftSection={<TbKey size={14} />}
                  onClick={openRotate}
                >
                  {t("team.dashboard.rotation.resume")}
                </Button>
              )}
            </Group>
          </Alert>
        )}
        {!isTeamAdmin && keyRotationStatus?.activeRotation && (
          <Alert
            icon={<TbKey size={18} />}
            color="blue"
            mb="md"
            title={t("team.dashboard.rotation.inProgress")}
          >
            <Text size="sm">
              {t("team.dashboard.rotation.memberUnavailable")}
            </Text>
          </Alert>
        )}
        {isTeamAdmin &&
          !keyRotationStatus?.activeRotation &&
          keyRotationStatus?.policy.reminderActive && (
            <Alert
              icon={<TbKey size={18} />}
              color={keyRotationStatus.policy.isDue ? "red" : "yellow"}
              mb="md"
              title={
                keyRotationStatus.policy.isDue
                  ? t("team.dashboard.rotation.due")
                  : t("team.dashboard.rotation.soon")
              }
            >
              <Group justify="space-between" align="center" wrap="wrap">
                <Text size="sm">
                  {t("team.dashboard.rotation.nextDue", {
                    date: new Date(
                      keyRotationStatus.policy.nextDueAt,
                    ).toLocaleDateString(intl.locale),
                  })}
                </Text>
                {keyRotationStatus.canOrchestrate && !teamKeyStale && (
                  <Button
                    size="compact-sm"
                    color={keyRotationStatus.policy.isDue ? "red" : "yellow"}
                    variant="light"
                    onClick={openRotate}
                    leftSection={<TbKey size={14} />}
                  >
                    {t("team.dashboard.e2e.rotateButton")}
                  </Button>
                )}
              </Group>
            </Alert>
          )}
        {myWrappedTeamKey === undefined ? null : myWrappedTeamKey &&
          teamKeyStale ? (
          <Alert
            icon={<TbLock size={18} />}
            color="red"
            mb="md"
            title={t("team.dashboard.e2e.staleKey.title")}
          >
            <Text size="sm" mb="sm">
              {t("team.dashboard.e2e.staleKey.desc")}
            </Text>
            <Text size="sm" mb="sm">
              {isTeamAdmin
                ? t("team.dashboard.e2e.staleKey.adminHint")
                : t("team.dashboard.e2e.staleKey.memberHint")}
            </Text>
            <Button
              size="compact-sm"
              color="red"
              variant="light"
              leftSection={<TbKey size={14} />}
              loading={clearingStaleKey}
              onClick={handleClearStaleKey}
            >
              {t("team.dashboard.e2e.staleKey.clearButton")}
            </Button>
          </Alert>
        ) : myWrappedTeamKey === null && isTeamAdmin ? (
          <Alert
            icon={<TbLock size={18} />}
            color="orange"
            mb="md"
            title={t("team.dashboard.e2e.banner.notInitTitle")}
          >
            <Text size="sm" mb="sm">
              {anotherMemberHoldsKey
                ? t("team.dashboard.e2e.banner.askResharDesc")
                : t("team.dashboard.e2e.banner.notInitDesc")}
            </Text>
            {!anotherMemberHoldsKey && (
              <Button
                size="compact-sm"
                color="orange"
                leftSection={<TbKey size={14} />}
                loading={e2eInitializing}
                onClick={handleInitE2E}
              >
                {t("team.dashboard.e2e.initButton")}
              </Button>
            )}
          </Alert>
        ) : myWrappedTeamKey === null && !isTeamAdmin ? (
          <Alert
            icon={<TbLock size={18} />}
            color="blue"
            mb="md"
            title={t("team.dashboard.e2e.banner.missingTitle")}
          >
            {t("team.dashboard.e2e.banner.missingDesc")}
          </Alert>
        ) : myWrappedTeamKey ? (
          <Alert
            icon={<TbLockOpen size={18} />}
            color="green"
            mb="md"
            title={t("team.dashboard.e2e.banner.activeTitle")}
          >
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
          keepMounted={false}
          onChange={(tab) => {
            if (tab && tab !== activeTab) {
              const nextQuery = { ...router.query };
              if (tab === "members") {
                delete nextQuery.tab;
              } else {
                nextQuery.tab = tab;
              }

              router.replace(
                { pathname: router.pathname, query: nextQuery },
                undefined,
                { shallow: true, scroll: false },
              );
            }
          }}
        >
          <Tabs.List mb="md" style={{ flexWrap: "wrap", rowGap: 4 }}>
            <Tabs.Tab
              value="members"
              leftSection={isMobile ? undefined : <TbUsers size={16} />}
            >
              {t("team.dashboard.tabs.members")}
            </Tabs.Tab>
            <Tabs.Tab
              value="folders"
              leftSection={isMobile ? undefined : <TbFolder size={16} />}
            >
              {t("team.dashboard.tabs.folders")}
            </Tabs.Tab>
            <Tabs.Tab
              value="search"
              leftSection={isMobile ? undefined : <TbSearch size={16} />}
            >
              {t("team.dashboard.tabs.search")}
            </Tabs.Tab>
            <Tabs.Tab
              value="shares"
              leftSection={isMobile ? undefined : <TbShare size={16} />}
            >
              {t("team.dashboard.tabs.shares")}
            </Tabs.Tab>
            {canViewActivity && (
              <Tabs.Tab
                value="activity"
                leftSection={isMobile ? undefined : <TbChartBar size={16} />}
              >
                {t("team.dashboard.tabs.activity")}
              </Tabs.Tab>
            )}
            {canViewSignatures && (
              <Tabs.Tab
                value="signatures"
                leftSection={
                  isMobile ? undefined : <TbFileDescription size={16} />
                }
              >
                {t("team.dashboard.tabs.signatures")}
                {teamSignaturesData &&
                  teamSignaturesData.pagination.total > 0 && (
                    <Badge size="xs" variant="filled" ml={6}>
                      {teamSignaturesData.pagination.total}
                    </Badge>
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
                      <Text fw={600} size="sm">
                        {member.user?.username || "-"}
                      </Text>
                      <Badge
                        variant="light"
                        size="sm"
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
                    </Group>
                    <Text size="xs" c="dimmed" mb={4}>
                      {member.user?.email}
                    </Text>
                    <Group gap={4}>
                      <Badge
                        size="xs"
                        variant="light"
                        color={
                          member.keyStatus === "CURRENT"
                            ? "green"
                            : member.keyStatus === "PENDING"
                              ? "orange"
                              : "red"
                        }
                      >
                        {t(
                          `team.dashboard.e2e.status.${(member.keyStatus || "MISSING").toLowerCase()}`,
                        )}
                      </Badge>
                      {isTeamAdmin &&
                        myWrappedTeamKey &&
                        !teamKeyStale &&
                        !member.hasTeamKey && (
                          <Tooltip
                            label={t("team.dashboard.e2e.generateLinkTooltip")}
                          >
                            <ActionIcon
                              variant="subtle"
                              color="orange"
                              size="sm"
                              onClick={() => handleShareKeyToMember(member.id)}
                            >
                              <TbKey size={14} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                      {isTeamAdmin && member.hasTeamKey && (
                        <Tooltip label={t("team.dashboard.e2e.keyOkTooltip")}>
                          <ActionIcon
                            variant="subtle"
                            color="green"
                            size="sm"
                            style={{ cursor: "default" }}
                          >
                            <TbLockOpen size={14} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                      {memberKeyLinks[member.id] && (
                        <Popover width={300} position="bottom-end" withArrow>
                          <Popover.Target>
                            <Button
                              size="compact-xs"
                              variant="light"
                              color="orange"
                            >
                              {t("team.dashboard.e2e.linkReady")}
                            </Button>
                          </Popover.Target>
                          <Popover.Dropdown>
                            <Text size="xs" mb="xs">
                              {t("team.dashboard.e2e.shareLinkTo", {
                                name: member.user?.username,
                              })}{" "}
                            </Text>
                            <TextInput
                              readOnly
                              size="xs"
                              value={memberKeyLinks[member.id]}
                              rightSection={
                                <CopyButton value={memberKeyLinks[member.id]}>
                                  {({ copied, copy }) => (
                                    <ActionIcon
                                      color={copied ? "green" : "blue"}
                                      onClick={copy}
                                      size="sm"
                                    >
                                      {copied ? (
                                        <TbCheck size={12} />
                                      ) : (
                                        <TbCopy size={12} />
                                      )}
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
                                      permissions: {
                                        canViewActivity:
                                          !member.canViewActivity,
                                      },
                                    })
                                  }
                                >
                                  {member.canViewActivity
                                    ? t("team.dashboard.members.revokeActivity")
                                    : t("team.dashboard.members.grantActivity")}
                                </Menu.Item>
                                <Menu.Item
                                  leftSection={<TbFileDescription size={14} />}
                                  onClick={() =>
                                    updatePermissionsMutation.mutate({
                                      memberId: member.id,
                                      permissions: {
                                        canViewSignatures:
                                          !member.canViewSignatures,
                                      },
                                    })
                                  }
                                >
                                  {member.canViewSignatures
                                    ? t(
                                        "team.dashboard.members.revokeSignatures",
                                      )
                                    : t(
                                        "team.dashboard.members.grantSignatures",
                                      )}
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
                      <Table.Th>
                        {t("team.dashboard.members.table.member")}
                      </Table.Th>
                      <Table.Th>
                        {t("team.dashboard.members.table.email")}
                      </Table.Th>
                      <Table.Th>
                        {t("team.dashboard.members.table.role")}
                      </Table.Th>
                      <Table.Th>
                        {t("team.dashboard.members.table.actions")}
                      </Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {team.members?.map((member) => (
                      <Table.Tr key={member.id}>
                        <Table.Td>
                          <Text fw={500}>{member.user?.username || "-"}</Text>
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
                            <Badge
                              size="xs"
                              variant="light"
                              color={
                                member.keyStatus === "CURRENT"
                                  ? "green"
                                  : member.keyStatus === "PENDING"
                                    ? "orange"
                                    : "red"
                              }
                            >
                              {t(
                                `team.dashboard.e2e.status.${(member.keyStatus || "MISSING").toLowerCase()}`,
                              )}
                            </Badge>
                            {/* E2E key status badge */}
                            {isTeamAdmin &&
                              myWrappedTeamKey &&
                              !teamKeyStale &&
                              !member.hasTeamKey && (
                                <Tooltip
                                  label={t(
                                    "team.dashboard.e2e.memberNoKeyTooltip",
                                  )}
                                >
                                  <ActionIcon
                                    variant="subtle"
                                    color="orange"
                                    onClick={() =>
                                      handleShareKeyToMember(member.id)
                                    }
                                  >
                                    <TbKey size={14} />
                                  </ActionIcon>
                                </Tooltip>
                              )}
                            {isTeamAdmin && member.hasTeamKey && (
                              <Tooltip
                                label={t(
                                  "team.dashboard.e2e.memberHasKeyTooltip",
                                )}
                              >
                                <ActionIcon
                                  variant="subtle"
                                  color="green"
                                  style={{ cursor: "default" }}
                                >
                                  <TbLockOpen size={14} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                            {/* Link modal for this member */}
                            {memberKeyLinks[member.id] && (
                              <Popover
                                width={400}
                                position="bottom-end"
                                withArrow
                              >
                                <Popover.Target>
                                  <Button
                                    size="compact-xs"
                                    variant="light"
                                    color="orange"
                                  >
                                    {t("team.dashboard.e2e.linkReady")}
                                  </Button>
                                </Popover.Target>
                                <Popover.Dropdown>
                                  <Text size="xs" mb="xs">
                                    {t("team.dashboard.e2e.shareLinkTo", {
                                      name: member.user?.username,
                                    })}
                                  </Text>
                                  <TextInput
                                    readOnly
                                    size="xs"
                                    value={memberKeyLinks[member.id]}
                                    rightSection={
                                      <CopyButton
                                        value={memberKeyLinks[member.id]}
                                      >
                                        {({ copied, copy }) => (
                                          <ActionIcon
                                            color={copied ? "green" : "blue"}
                                            onClick={copy}
                                            size="sm"
                                          >
                                            {copied ? (
                                              <TbCheck size={12} />
                                            ) : (
                                              <TbCopy size={12} />
                                            )}
                                          </ActionIcon>
                                        )}
                                      </CopyButton>
                                    }
                                  />
                                  <Text size="xs" c="dimmed" mt="xs">
                                    {t(
                                      "team.dashboard.e2e.linkSecurityWarning",
                                    )}
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
                                        leftSection={
                                          <TbShieldCheck size={14} />
                                        }
                                        onClick={() =>
                                          updateRoleMutation.mutate({
                                            memberId: member.id,
                                            role: "ADMIN",
                                          })
                                        }
                                      >
                                        {t(
                                          "team.dashboard.members.promoteAdmin",
                                        )}
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
                                        {t(
                                          "team.dashboard.members.demoteToMember",
                                        )}
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
                                              permissions: {
                                                canViewActivity:
                                                  !member.canViewActivity,
                                              },
                                            })
                                          }
                                        >
                                          {member.canViewActivity
                                            ? t(
                                                "team.dashboard.members.revokeActivity",
                                              )
                                            : t(
                                                "team.dashboard.members.grantActivity",
                                              )}
                                        </Menu.Item>
                                        <Menu.Item
                                          leftSection={
                                            <TbFileDescription size={14} />
                                          }
                                          onClick={() =>
                                            updatePermissionsMutation.mutate({
                                              memberId: member.id,
                                              permissions: {
                                                canViewSignatures:
                                                  !member.canViewSignatures,
                                              },
                                            })
                                          }
                                        >
                                          {member.canViewSignatures
                                            ? t(
                                                "team.dashboard.members.revokeSignatures",
                                              )
                                            : t(
                                                "team.dashboard.members.grantSignatures",
                                              )}
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
                {t("team.dashboard.folders.count", {
                  n: folders?.length || 0,
                  max: process.env.NEXT_PUBLIC_TEAM_MAX_FOLDERS || 10,
                })}
              </Text>
              {isTeamAdmin && (
                <Button
                  size="compact-sm"
                  leftSection={<TbFolderPlus size={14} />}
                  onClick={openFolder}
                  disabled={
                    (folders?.length || 0) >=
                    parseInt(process.env.NEXT_PUBLIC_TEAM_MAX_FOLDERS || "10")
                  }
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
                            color={
                              folder.color || "var(--mantine-color-blue-6)"
                            }
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
                                  setDeleteFolderTarget({
                                    id: folder.id,
                                    name: folder.name,
                                  });
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
                          {t("team.dashboard.folders.sharesCount", {
                            n: folder._count?.shares || 0,
                          })}
                        </Text>
                      </Group>
                    </Card>
                  </Grid.Col>
                ))}
              </Grid>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="search">
            <TeamSearchPanel
              teamId={teamIdStr}
              active={activeTab === "search"}
            />
          </Tabs.Panel>

          {/* Shares tab */}
          <Tabs.Panel value="shares">
            <TeamSharesPanel teamId={teamIdStr} />
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
                              log.action === "DOWNLOAD"
                                ? "green"
                                : log.action === "UPLOAD"
                                  ? "blue"
                                  : log.action === "FOLDER_CREATE" ||
                                      log.action === "FOLDER_DELETE"
                                    ? "violet"
                                    : log.action === "INVITE" ||
                                        log.action === "MEMBER_JOIN"
                                      ? "teal"
                                      : log.action === "MEMBER_REMOVE"
                                        ? "red"
                                        : log.action === "ROLE_CHANGE"
                                          ? "orange"
                                          : log.action === "SHARE"
                                            ? "cyan"
                                            : log.action === "SIGNATURE_REQUEST"
                                              ? "indigo"
                                              : log.action ===
                                                  "SIGNATURE_SIGNED"
                                                ? "lime"
                                                : log.action ===
                                                    "SIGNATURE_COMPLETE"
                                                  ? "green"
                                                  : "gray"
                            }
                          >
                            {log.action === "SIGNATURE_REQUEST"
                              ? t("team.dashboard.activity.signatureRequest")
                              : log.action === "SIGNATURE_SIGNED"
                                ? t("team.dashboard.activity.signatureSigned")
                                : log.action === "SIGNATURE_COMPLETE"
                                  ? t(
                                      "team.dashboard.activity.signatureComplete",
                                    )
                                  : log.action === "DOWNLOAD"
                                    ? t("team.dashboard.activity.download")
                                    : log.action === "UPLOAD"
                                      ? t("team.dashboard.activity.upload")
                                      : log.action === "FOLDER_CREATE"
                                        ? t(
                                            "team.dashboard.activity.folderCreate",
                                          )
                                        : log.action === "FOLDER_DELETE"
                                          ? t(
                                              "team.dashboard.activity.folderDelete",
                                            )
                                          : log.action === "INVITE"
                                            ? t(
                                                "team.dashboard.activity.invite",
                                              )
                                            : log.action === "MEMBER_JOIN"
                                              ? t(
                                                  "team.dashboard.activity.memberJoin",
                                                )
                                              : log.action === "MEMBER_REMOVE"
                                                ? t(
                                                    "team.dashboard.activity.memberRemove",
                                                  )
                                                : log.action === "ROLE_CHANGE"
                                                  ? t(
                                                      "team.dashboard.activity.roleChange",
                                                    )
                                                  : log.action === "SHARE"
                                                    ? t(
                                                        "team.dashboard.activity.share",
                                                      )
                                                    : log.action}
                          </Badge>
                          <Text size="xs" c="dimmed">
                            {new Date(log.createdAt).toLocaleString(
                              intl.locale,
                              { timeZone: "Europe/Paris" },
                            )}
                          </Text>
                        </Group>
                        <Text size="xs">{log.actorEmail}</Text>
                        {(log.fileName || log.folder?.name) && (
                          <Text
                            size="xs"
                            c="dimmed"
                            lineClamp={1}
                            style={{
                              overflowWrap: "anywhere",
                              hyphens: "auto",
                            }}
                          >
                            {log.fileName || log.folder?.name}
                          </Text>
                        )}
                      </Card>
                    ))}
                  </Stack>
                ) : (
                  <Paper withBorder>
                    <Table striped style={{ tableLayout: "fixed" }}>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th style={{ width: 170 }}>
                            {t("team.dashboard.activity.headerAction")}
                          </Table.Th>
                          <Table.Th style={{ width: 200 }}>
                            {t("team.dashboard.activity.headerUser")}
                          </Table.Th>
                          <Table.Th>
                            {t("team.dashboard.activity.headerFileFolder")}
                          </Table.Th>
                          <Table.Th style={{ width: 160 }}>
                            {t("team.dashboard.activity.headerDate")}
                          </Table.Th>
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
                                      : log.action === "FOLDER_CREATE" ||
                                          log.action === "FOLDER_DELETE"
                                        ? "violet"
                                        : log.action === "INVITE" ||
                                            log.action === "MEMBER_JOIN"
                                          ? "teal"
                                          : log.action === "MEMBER_REMOVE"
                                            ? "red"
                                            : log.action === "ROLE_CHANGE"
                                              ? "orange"
                                              : log.action === "SHARE"
                                                ? "cyan"
                                                : log.action ===
                                                    "SIGNATURE_REQUEST"
                                                  ? "indigo"
                                                  : log.action ===
                                                      "SIGNATURE_SIGNED"
                                                    ? "lime"
                                                    : log.action ===
                                                        "SIGNATURE_COMPLETE"
                                                      ? "green"
                                                      : "gray"
                                }
                              >
                                {log.action === "SIGNATURE_REQUEST"
                                  ? t(
                                      "team.dashboard.activity.signatureRequest",
                                    )
                                  : log.action === "SIGNATURE_SIGNED"
                                    ? t(
                                        "team.dashboard.activity.signatureSigned",
                                      )
                                    : log.action === "SIGNATURE_COMPLETE"
                                      ? t(
                                          "team.dashboard.activity.signatureComplete",
                                        )
                                      : log.action === "DOWNLOAD"
                                        ? t("team.dashboard.activity.download")
                                        : log.action === "UPLOAD"
                                          ? t("team.dashboard.activity.upload")
                                          : log.action === "FOLDER_CREATE"
                                            ? t(
                                                "team.dashboard.activity.folderCreate",
                                              )
                                            : log.action === "FOLDER_DELETE"
                                              ? t(
                                                  "team.dashboard.activity.folderDelete",
                                                )
                                              : log.action === "INVITE"
                                                ? t(
                                                    "team.dashboard.activity.invite",
                                                  )
                                                : log.action === "MEMBER_JOIN"
                                                  ? t(
                                                      "team.dashboard.activity.memberJoin",
                                                    )
                                                  : log.action ===
                                                      "MEMBER_REMOVE"
                                                    ? t(
                                                        "team.dashboard.activity.memberRemove",
                                                      )
                                                    : log.action ===
                                                        "ROLE_CHANGE"
                                                      ? t(
                                                          "team.dashboard.activity.roleChange",
                                                        )
                                                      : log.action === "SHARE"
                                                        ? t(
                                                            "team.dashboard.activity.share",
                                                          )
                                                        : log.action}
                              </Badge>
                            </Table.Td>
                            <Table.Td style={{ overflow: "hidden" }}>
                              <Text size="sm" truncate>
                                {log.actorEmail}
                              </Text>
                            </Table.Td>
                            <Table.Td style={{ overflow: "hidden" }}>
                              <Text size="sm" truncate>
                                {log.fileName || log.folder?.name || "-"}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="xs" c="dimmed">
                                {new Date(log.createdAt).toLocaleString(
                                  intl.locale,
                                  { timeZone: "Europe/Paris" },
                                )}
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
                  {activeTeamSignatures.length} document(s) de signature
                </Text>
                <Button
                  size="compact-sm"
                  leftSection={<TbFileDescription size={14} />}
                  onClick={() => router.push("/signing/new")}
                >
                  {t("team.dashboard.buttons.newRequest")}
                </Button>
              </Group>

              {!teamSignatures || activeTeamSignatures.length === 0 ? (
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
                  {activeTeamSignatures.map((doc) => {
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
                      COMPLETED: t(
                        "team.dashboard.signatures.status.completed",
                      ),
                      CANCELLED: t(
                        "team.dashboard.signatures.status.cancelled",
                      ),
                      REJECTED: t("team.dashboard.signatures.status.rejected"),
                      AWAITING_FINALIZATION: t(
                        "team.dashboard.signatures.status.awaitingFinalization",
                      ),
                    };
                    return (
                      <Card
                        key={doc.id}
                        withBorder
                        padding="sm"
                        style={{ cursor: "pointer" }}
                        onClick={() => router.push(`/signing/${doc.id}`)}
                      >
                        <Group
                          justify="space-between"
                          align="flex-start"
                          wrap="nowrap"
                          mb={4}
                        >
                          <Group
                            gap={6}
                            align="flex-start"
                            style={{ flex: 1, minWidth: 0 }}
                          >
                            <Text
                              fw={600}
                              size="sm"
                              lineClamp={1}
                              style={{
                                flex: 1,
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                hyphens: "auto",
                              }}
                            >
                              {doc.fileName ||
                                doc.title ||
                                t("team.dashboard.signatures.untitled")}
                            </Text>
                            {(doc as any).fileDeleted && (
                              <Tooltip
                                label={t(
                                  "team.dashboard.signatures.fileDeletedTooltip",
                                )}
                              >
                                <Badge
                                  color="red"
                                  variant="light"
                                  size="xs"
                                  leftSection={<TbFileOff size={10} />}
                                >
                                  {t("team.dashboard.signatures.deleted")}
                                </Badge>
                              </Tooltip>
                            )}
                          </Group>
                          <Badge
                            color={sigStatusColors[doc.status] || "gray"}
                            variant="light"
                            size="sm"
                            style={{ flexShrink: 0 }}
                          >
                            {sigStatusLabels[doc.status] || doc.status}
                          </Badge>
                        </Group>
                        <Text size="xs" c="dimmed" mb={4}>
                          {t("team.dashboard.signatures.by")} :{" "}
                          {creator?.username || creator?.email || "-"}
                        </Text>
                        <Group gap={4} mb={4}>
                          {doc.recipients?.map((r) => (
                            <Badge
                              key={r.id}
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
                          ))}
                        </Group>
                        <Text size="xs" c="dimmed">
                          {new Date(doc.createdAt).toLocaleDateString(
                            intl.locale,
                            { timeZone: "Europe/Paris" },
                          )}
                        </Text>
                        {doc.status === "COMPLETED" &&
                          !(doc as any).fileDeleted && (
                            <Group mt="xs" onClick={(e) => e.stopPropagation()}>
                              <Button
                                size="compact-xs"
                                variant="light"
                                color="green"
                                onClick={async () => {
                                  if ((doc as any).isE2EEncrypted) {
                                    router.push(`/signing/${doc.id}`);
                                    return;
                                  }
                                  try {
                                    const blob =
                                      await signingService.downloadSigned(
                                        doc.id,
                                      );
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement("a");
                                    a.href = url;
                                    a.download = `${doc.title || doc.fileName || "document"}_signe.pdf`;
                                    a.click();
                                    URL.revokeObjectURL(url);
                                  } catch {
                                    toast.error(
                                      t(
                                        "team.dashboard.signatures.downloadError",
                                      ),
                                    );
                                  }
                                }}
                              >
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
                  <Table
                    striped
                    highlightOnHover
                    style={{ tableLayout: "fixed" }}
                  >
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>
                          {t("team.dashboard.signatures.headerDocument")}
                        </Table.Th>
                        <Table.Th style={{ width: 140 }}>
                          {t("team.dashboard.signatures.headerCreator")}
                        </Table.Th>
                        <Table.Th style={{ width: 130 }}>
                          {t("team.dashboard.signatures.headerSigners")}
                        </Table.Th>
                        <Table.Th style={{ width: 150 }}>
                          {t("team.dashboard.signatures.headerStatus")}
                        </Table.Th>
                        <Table.Th style={{ width: 100 }}>
                          {t("team.dashboard.activity.headerDate")}
                        </Table.Th>
                        <Table.Th style={{ width: 100 }}>
                          {t("team.dashboard.signatures.headerActions")}
                        </Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {activeTeamSignatures.map((doc) => {
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
                          PENDING: t(
                            "team.dashboard.signatures.status.pending",
                          ),
                          PARTIAL: t(
                            "team.dashboard.signatures.status.partial",
                          ),
                          COMPLETED: t(
                            "team.dashboard.signatures.status.completed",
                          ),
                          CANCELLED: t(
                            "team.dashboard.signatures.status.cancelled",
                          ),
                          REJECTED: t(
                            "team.dashboard.signatures.status.rejected",
                          ),
                          AWAITING_FINALIZATION: t(
                            "team.dashboard.signatures.status.awaitingFinalization",
                          ),
                        };
                        return (
                          <Table.Tr
                            key={doc.id}
                            style={{ cursor: "pointer" }}
                            onClick={() => router.push(`/signing/${doc.id}`)}
                          >
                            <Table.Td style={{ overflow: "hidden" }}>
                              <Group gap={6} wrap="nowrap">
                                <Text
                                  fw={500}
                                  truncate
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    overflowWrap: "anywhere",
                                    hyphens: "auto",
                                  }}
                                >
                                  {doc.fileName ||
                                    doc.title ||
                                    t("team.dashboard.signatures.untitled")}
                                </Text>
                                {(doc as any).fileDeleted && (
                                  <Tooltip
                                    label={t(
                                      "team.dashboard.signatures.fileDeletedTooltip",
                                    )}
                                  >
                                    <Badge
                                      color="red"
                                      variant="light"
                                      size="xs"
                                      leftSection={<TbFileOff size={10} />}
                                    >
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
                                  <Tooltip
                                    key={r.id}
                                    label={`${r.name} (${r.email})`}
                                  >
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
                                {new Date(doc.createdAt).toLocaleDateString(
                                  intl.locale,
                                  { timeZone: "Europe/Paris" },
                                )}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Group
                                gap={4}
                                wrap="nowrap"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Tooltip
                                  label={t(
                                    "team.dashboard.signatures.viewDetails",
                                  )}
                                >
                                  <ActionIcon
                                    variant="light"
                                    color="blue"
                                    size="sm"
                                    onClick={() =>
                                      router.push(`/signing/${doc.id}`)
                                    }
                                  >
                                    <TbFileDescription size={14} />
                                  </ActionIcon>
                                </Tooltip>
                                {doc.status === "COMPLETED" &&
                                  !(doc as any).fileDeleted && (
                                    <Tooltip
                                      label={t(
                                        "team.dashboard.signatures.downloadSignedPdf",
                                      )}
                                    >
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
                                            const blob =
                                              await signingService.downloadSigned(
                                                doc.id,
                                              );
                                            const url =
                                              URL.createObjectURL(blob);
                                            const a =
                                              document.createElement("a");
                                            a.href = url;
                                            a.download = `${doc.title || doc.fileName || "document"}_signe.pdf`;
                                            a.click();
                                            URL.revokeObjectURL(url);
                                          } catch {
                                            toast.error(
                                              t(
                                                "team.dashboard.signatures.downloadError",
                                              ),
                                            );
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

              {/* Deleted team signatures */}
              {deletedTeamSignatures.length > 0 && (
                <>
                  <Title order={4} mt="xl" mb="xs">
                    <Group gap="xs">
                      <TbFileOff size={18} />
                      {t("signing.deleted-documents")}
                    </Group>
                  </Title>
                  <Text size="xs" c="dimmed" mb="sm">
                    {t("signing.deleted-documents.info")}
                  </Text>
                  {isMobile ? (
                    <Stack gap="sm">
                      {deletedTeamSignatures.map((doc) => {
                        const creator = (doc as any).creator;
                        const signers = doc.recipients
                          ?.filter((r) => r.role === "SIGNER")
                          .map((r) => r.name)
                          .join(", ");
                        return (
                          <Card
                            key={doc.id}
                            withBorder
                            padding="sm"
                            radius="md"
                            style={{ cursor: "pointer", opacity: 0.7 }}
                            onClick={() => router.push(`/signing/${doc.id}`)}
                          >
                            <Group
                              gap={6}
                              mb={4}
                              wrap="nowrap"
                              align="flex-start"
                            >
                              <TbFileOff
                                size={14}
                                color="var(--mantine-color-red-6)"
                                style={{ flexShrink: 0, marginTop: 2 }}
                              />
                              <Text
                                fw={600}
                                size="sm"
                                lineClamp={1}
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  overflowWrap: "anywhere",
                                  hyphens: "auto",
                                }}
                              >
                                {doc.fileName ||
                                  doc.title ||
                                  signers ||
                                  t("team.dashboard.signatures.untitled")}
                              </Text>
                            </Group>
                            {(doc as any).message && (
                              <Text
                                size="xs"
                                c="dimmed"
                                lineClamp={1}
                                fs="italic"
                                mb={4}
                                style={{ overflowWrap: "anywhere" }}
                              >
                                {(doc as any).message}
                              </Text>
                            )}
                            <Group justify="space-between" mb={4}>
                              <Text size="xs" c="dimmed">
                                {signers || "-"}
                              </Text>
                              <Badge
                                color={
                                  {
                                    PENDING: "yellow",
                                    PARTIAL: "blue",
                                    COMPLETED: "green",
                                    CANCELLED: "gray",
                                    REJECTED: "red",
                                    AWAITING_FINALIZATION: "orange",
                                  }[doc.status] || "gray"
                                }
                                variant="light"
                                size="sm"
                              >
                                {signatureStatusTranslationKeys[doc.status]
                                  ? t(
                                      signatureStatusTranslationKeys[
                                        doc.status
                                      ],
                                    )
                                  : doc.status}
                              </Badge>
                            </Group>
                            <Group justify="space-between">
                              <Text size="xs" c="dimmed">
                                {creator?.username || creator?.email || "-"}
                              </Text>
                              <Text size="xs" c="dimmed">
                                {new Date(doc.createdAt).toLocaleDateString(
                                  intl.locale,
                                  { timeZone: "Europe/Paris" },
                                )}
                              </Text>
                            </Group>
                          </Card>
                        );
                      })}
                    </Stack>
                  ) : (
                    <Paper withBorder>
                      <Table striped style={{ tableLayout: "fixed" }}>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>
                              {t("team.dashboard.signatures.headerDocument")}
                            </Table.Th>
                            <Table.Th style={{ width: 160 }}>
                              {t("signing.deleted.signers")}
                            </Table.Th>
                            <Table.Th style={{ width: 130 }}>
                              {t("team.dashboard.signatures.headerCreator")}
                            </Table.Th>
                            <Table.Th style={{ width: 150 }}>
                              {t("team.dashboard.signatures.headerStatus")}
                            </Table.Th>
                            <Table.Th style={{ width: 100 }}>
                              {t("team.dashboard.activity.headerDate")}
                            </Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {deletedTeamSignatures.map((doc) => {
                            const creator = (doc as any).creator;
                            const signers = doc.recipients
                              ?.filter((r) => r.role === "SIGNER")
                              .map((r) => r.name)
                              .join(", ");
                            return (
                              <Table.Tr
                                key={doc.id}
                                style={{ cursor: "pointer", opacity: 0.7 }}
                                onClick={() =>
                                  router.push(`/signing/${doc.id}`)
                                }
                              >
                                <Table.Td style={{ overflow: "hidden" }}>
                                  <Stack gap={2}>
                                    <Group gap={6} wrap="nowrap">
                                      <TbFileOff
                                        size={14}
                                        color="var(--mantine-color-red-6)"
                                      />
                                      <Text
                                        fw={500}
                                        truncate
                                        style={{
                                          flex: 1,
                                          minWidth: 0,
                                          overflowWrap: "anywhere",
                                          hyphens: "auto",
                                        }}
                                      >
                                        {doc.fileName ||
                                          doc.title ||
                                          signers ||
                                          t(
                                            "team.dashboard.signatures.untitled",
                                          )}
                                      </Text>
                                    </Group>
                                    {(doc as any).message && (
                                      <Text
                                        size="xs"
                                        c="dimmed"
                                        lineClamp={1}
                                        fs="italic"
                                        ml={20}
                                        style={{ overflowWrap: "anywhere" }}
                                      >
                                        {(doc as any).message}
                                      </Text>
                                    )}
                                  </Stack>
                                </Table.Td>
                                <Table.Td>
                                  <Text
                                    size="sm"
                                    truncate
                                    style={{ overflowWrap: "anywhere" }}
                                  >
                                    {signers || "-"}
                                  </Text>
                                </Table.Td>
                                <Table.Td>
                                  <Text size="sm">
                                    {creator?.username || creator?.email || "-"}
                                  </Text>
                                </Table.Td>
                                <Table.Td>
                                  <Badge
                                    color={
                                      {
                                        PENDING: "yellow",
                                        PARTIAL: "blue",
                                        COMPLETED: "green",
                                        CANCELLED: "gray",
                                        REJECTED: "red",
                                        AWAITING_FINALIZATION: "orange",
                                      }[doc.status] || "gray"
                                    }
                                    variant="light"
                                  >
                                    {signatureStatusTranslationKeys[doc.status]
                                      ? t(
                                          signatureStatusTranslationKeys[
                                            doc.status
                                          ],
                                        )
                                      : doc.status}
                                  </Badge>
                                </Table.Td>
                                <Table.Td>
                                  <Text size="sm" c="dimmed">
                                    {new Date(doc.createdAt).toLocaleDateString(
                                      intl.locale,
                                      { timeZone: "Europe/Paris" },
                                    )}
                                  </Text>
                                </Table.Td>
                              </Table.Tr>
                            );
                          })}
                        </Table.Tbody>
                      </Table>
                    </Paper>
                  )}
                </>
              )}
              {(teamSignaturesData?.pagination.totalPages || 0) > 1 && (
                <Group justify="center" mt="lg">
                  <Pagination
                    value={signaturePage}
                    onChange={setSignaturePage}
                    total={teamSignaturesData?.pagination.totalPages || 1}
                    withEdges
                  />
                </Group>
              )}
            </Tabs.Panel>
          )}

        </Tabs>
      </Container>

      {/* Rotation confirmation modal */}
      <Modal
        opened={rotateOpened}
        onClose={() => {
          if (!rotating) closeRotate();
        }}
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
                <Button variant="subtle" onClick={closeRotate}>
                  {t("common.cancel")}
                </Button>
                <Button
                  color="orange"
                  onClick={handleRotateKey}
                  leftSection={<TbKey size={14} />}
                >
                  {t("team.dashboard.modals.rotation.startBtn")}
                </Button>
              </Group>
            </>
          )}
          {rotating && rotateProgress && (
            <>
              <Text size="sm" fw={500}>
                {t("team.dashboard.modals.rotation.progress", {
                  done: rotateProgress.filesDone,
                  total: rotateProgress.filesTotal,
                })}
              </Text>
              {rotateProgress.currentFile && (
                <Text
                  size="xs"
                  c="dimmed"
                  lineClamp={1}
                  style={{ overflowWrap: "anywhere", hyphens: "auto" }}
                >
                  {rotateProgress.currentFile}
                </Text>
              )}
              <Progress
                value={
                  rotateProgress.filesTotal > 0
                    ? (rotateProgress.filesDone / rotateProgress.filesTotal) *
                      100
                    : 0
                }
                animated
                size="lg"
              />
              {rotateProgress.filesFailed > 0 && (
                <Text size="xs" c="red">
                  {t("team.dashboard.modals.rotation.failures", {
                    n: rotateProgress.filesFailed,
                  })}
                </Text>
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
              <Text size="sm">
                {t("team.dashboard.modals.rotation.preparing")}
              </Text>
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
                {m.name}{" "}
                <Text span c="dimmed" size="xs">
                  ({m.email})
                </Text>
              </Text>
              <TextInput
                readOnly
                size="xs"
                value={m.link}
                rightSection={
                  <CopyButton value={m.link}>
                    {({ copied, copy }) => (
                      <ActionIcon
                        color={copied ? "green" : "blue"}
                        onClick={copy}
                        size="sm"
                      >
                        {copied ? <TbCheck size={12} /> : <TbCopy size={12} />}
                      </ActionIcon>
                    )}
                  </CopyButton>
                }
              />
            </Paper>
          ))}
          <Button onClick={closeInitLinks} mt="sm">
            {t("team.dashboard.modals.initLinks.doneBtn")}
          </Button>
        </Stack>
      </Modal>

      {/* Invite modal */}
      <Modal
        opened={inviteOpened}
        onClose={closeInvite}
        title={t("team.dashboard.modals.invite.title")}
      >
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
      <Modal
        opened={folderOpened}
        onClose={closeFolder}
        title={t("team.dashboard.modals.createFolder.title")}
      >
        <Stack gap="md">
          <TextInput
            label={t("team.dashboard.modals.createFolder.nameLabel")}
            placeholder={t(
              "team.dashboard.modals.createFolder.namePlaceholder",
            )}
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
              {t("team.dashboard.modals.deleteFolder.warning", {
                name: deleteFolderTarget.name,
              })}
              <ul style={{ margin: "8px 0 0 0", paddingLeft: 16 }}>
                <li>{t("team.dashboard.modals.deleteFolder.listFiles")}</li>
                <li>{t("team.dashboard.modals.deleteFolder.listShares")}</li>
                <li>
                  {t("team.dashboard.modals.deleteFolder.listPermissions")}
                </li>
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
              {t("team.dashboard.modals.removeMember.confirm", {
                name: removeMemberTarget.username || removeMemberTarget.email,
                email: removeMemberTarget.email,
              })}
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

// ============================================================================
const TeamSearchPanel = ({
  teamId,
  active,
}: {
  teamId: string;
  active: boolean;
}) => {
  const router = useRouter();
  const t = useTranslate();
  const intl = useIntl();
  const isMobile = useMediaQuery("(max-width: 680px)");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<TeamSearchKind | "ALL">("ALL");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [author, setAuthor] = useState<string | null>(null);
  const [extension, setExtension] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [resultPage, setResultPage] = useState(1);
  const [filtersOpened, { toggle: toggleFilters }] = useDisclosure(false);

  const { data: index, isLoading } = useQuery({
    queryKey: ["team.searchIndex", teamId],
    queryFn: () => teamService.getSearchIndex(teamId),
    enabled: active && !!teamId,
    staleTime: 60_000,
  });

  const authorOptions = useMemo(() => {
    if (!index) return [];
    const values = new Set<string>();
    index.files.forEach(
      (file) => file.author?.email && values.add(file.author.email),
    );
    index.signatures.forEach(
      (item) => item.author?.email && values.add(item.author.email),
    );
    index.activity.forEach(
      (item) => item.actorEmail && values.add(item.actorEmail),
    );
    return [...values].sort().map((value) => ({ value, label: value }));
  }, [index]);

  const extensionOptions = useMemo(() => {
    if (!index) return [];
    const values = new Set<string>();
    index.files.forEach((file) => {
      const match = /\.([a-z0-9]+)$/i.exec(file.name);
      if (match?.[1]) values.add(match[1].toLocaleLowerCase());
    });
    return [...values].sort().map((value) => ({ value, label: `.${value}` }));
  }, [index]);

  const statusOptions = useMemo(() => {
    if (!index) return [];
    const values = new Set(index.signatures.map((item) => item.status));
    index.files.forEach(
      (file) => file.signature?.status && values.add(file.signature.status),
    );
    return [...values].sort().map((value) => {
      const translationKey = signatureStatusTranslationKeys[value];
      return { value, label: translationKey ? t(translationKey) : value };
    });
  }, [index, t]);

  const results = useMemo(
    () =>
      index
        ? buildTeamSearchResults(index, {
            query,
            kind,
            folderId: folderId || undefined,
            author: author || undefined,
            extension: extension || undefined,
            status: status || undefined,
            dateFrom: dateFrom || undefined,
            dateTo: dateTo || undefined,
          })
        : [],
    [index, query, kind, folderId, author, extension, status, dateFrom, dateTo],
  );
  const resultPageSize = 50;
  const resultPageCount = Math.max(
    1,
    Math.ceil(results.length / resultPageSize),
  );
  const visibleResults = results.slice(
    (resultPage - 1) * resultPageSize,
    resultPage * resultPageSize,
  );

  useEffect(() => {
    setResultPage(1);
  }, [query, kind, folderId, author, extension, status, dateFrom, dateTo]);

  const advancedFilterCount = [
    folderId,
    author,
    extension,
    status,
    dateFrom,
    dateTo,
  ].filter(Boolean).length;
  const hasFilters = !!query || kind !== "ALL" || advancedFilterCount > 0;

  const resetFilters = () => {
    setQuery("");
    setKind("ALL");
    setFolderId(null);
    setAuthor(null);
    setExtension(null);
    setStatus(null);
    setDateFrom("");
    setDateTo("");
  };

  const openResult = (result: (typeof results)[number]) => {
    if (result.kind === "FILE" && result.folderId && result.fileId) {
      router.push(
        `/team/${teamId}/folder/${result.folderId}?highlight=${result.fileId}`,
      );
    } else if (result.kind === "FOLDER" && result.folderId) {
      router.push(`/team/${teamId}/folder/${result.folderId}`);
    } else if (result.kind === "SIGNATURE") {
      router.push(`/signing/${result.id}`);
    }
  };

  const kindBadge = (resultKind: TeamSearchKind) => {
    const config = {
      FILE: { color: "blue", label: t("team.search.kind.file") },
      FOLDER: { color: "yellow", label: t("team.search.kind.folder") },
      SIGNATURE: { color: "green", label: t("team.search.kind.signature") },
      ACTIVITY: { color: "gray", label: t("team.search.kind.activity") },
    }[resultKind];
    return (
      <Badge size="sm" variant="light" color={config.color}>
        {config.label}
      </Badge>
    );
  };

  const kindIcon = (resultKind: TeamSearchKind) => {
    const icon = {
      FILE: <TbFileDescription size={17} />,
      FOLDER: <TbFolder size={17} />,
      SIGNATURE: <TbShieldCheck size={17} />,
      ACTIVITY: <TbChartBar size={17} />,
    }[resultKind];
    return (
      <Box
        className={searchStyles.kindIcon}
        data-kind={resultKind}
        aria-hidden="true"
      >
        {icon}
      </Box>
    );
  };

  const resultKindLabel = (resultKind: TeamSearchKind) =>
    ({
      FILE: t("team.search.kind.file"),
      FOLDER: t("team.search.kind.folder"),
      SIGNATURE: t("team.search.kind.signature"),
      ACTIVITY: t("team.search.kind.activity"),
    })[resultKind];

  const signatureStatusLabel = (value: string) => {
    const translationKey = signatureStatusTranslationKeys[value];
    return translationKey ? t(translationKey) : value;
  };

  const resultInteraction = (result: (typeof results)[number]) => {
    if (result.kind === "ACTIVITY") return {};
    return {
      role: "link",
      tabIndex: 0,
      onClick: () => openResult(result),
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openResult(result);
        }
      },
    };
  };

  if (isLoading) {
    return (
      <Box ta="center" py="xl">
        <Loader size="md" />
      </Box>
    );
  }

  return (
    <Stack gap="sm">
      <Box className={searchStyles.searchArea}>
        <Box className={searchStyles.toolbar}>
          <TextInput
            className={searchStyles.searchInput}
            size="md"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            leftSection={<TbSearch size={18} />}
            rightSection={
              query ? (
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  onClick={() => setQuery("")}
                  aria-label={t("team.search.resetQuery")}
                >
                  <TbX size={15} />
                </ActionIcon>
              ) : undefined
            }
            placeholder={t("team.search.placeholder")}
            aria-label={t("team.search.placeholder")}
          />
          <Select
            className={searchStyles.kindSelect}
            size="md"
            aria-label={t("team.search.filters.kind")}
            value={kind}
            onChange={(value) =>
              setKind((value || "ALL") as TeamSearchKind | "ALL")
            }
            allowDeselect={false}
            data={[
              { value: "ALL", label: t("team.search.kind.all") },
              { value: "FILE", label: t("team.search.kind.file") },
              { value: "FOLDER", label: t("team.search.kind.folder") },
              { value: "SIGNATURE", label: t("team.search.kind.signature") },
              ...(index?.capabilities.canViewActivity
                ? [{ value: "ACTIVITY", label: t("team.search.kind.activity") }]
                : []),
            ]}
          />
          <Button
            className={searchStyles.filtersButton}
            size="md"
            variant={
              filtersOpened || advancedFilterCount > 0 ? "light" : "default"
            }
            leftSection={<TbAdjustmentsHorizontal size={17} />}
            rightSection={
              advancedFilterCount > 0 ? (
                <Badge size="xs" circle variant="filled">
                  {advancedFilterCount}
                </Badge>
              ) : undefined
            }
            onClick={toggleFilters}
            aria-expanded={filtersOpened}
          >
            {t("team.search.filters.open")}
          </Button>
          {hasFilters && (
            <Tooltip label={t("team.search.reset")}>
              <ActionIcon
                className={searchStyles.resetButton}
                size={42}
                variant="subtle"
                color="gray"
                onClick={resetFilters}
                aria-label={t("team.search.reset")}
              >
                <TbX size={18} />
              </ActionIcon>
            </Tooltip>
          )}
        </Box>

        <Collapse in={filtersOpened}>
          <Box className={searchStyles.filtersGrid}>
            <Select
              size="sm"
              label={t("team.search.filters.folder")}
              value={folderId}
              onChange={setFolderId}
              data={(index?.folders || []).map((folder) => ({
                value: folder.id,
                label: folder.name,
              }))}
              clearable
              searchable
            />
            <Select
              size="sm"
              label={t("team.search.filters.author")}
              value={author}
              onChange={setAuthor}
              data={authorOptions}
              clearable
              searchable
            />
            <Select
              size="sm"
              label={t("team.search.filters.extension")}
              value={extension}
              onChange={setExtension}
              data={extensionOptions}
              clearable
            />
            <Select
              size="sm"
              label={t("team.search.filters.status")}
              value={status}
              onChange={setStatus}
              data={statusOptions}
              clearable
            />
            <TextInput
              size="sm"
              type="date"
              label={t("team.search.filters.from")}
              value={dateFrom}
              onChange={(event) => setDateFrom(event.currentTarget.value)}
            />
            <TextInput
              size="sm"
              type="date"
              label={t("team.search.filters.to")}
              value={dateTo}
              onChange={(event) => setDateTo(event.currentTarget.value)}
            />
          </Box>
        </Collapse>
      </Box>

      <Group justify="space-between" className={searchStyles.resultSummary}>
        <Text size="sm" c="dimmed">
          {t("team.search.results", { count: results.length })}
        </Text>
      </Group>

      {results.length === 0 ? (
        <Paper withBorder p="xl" ta="center">
          <Text c="dimmed" size="sm">
            {t("team.search.empty")}
          </Text>
        </Paper>
      ) : isMobile ? (
        <Stack gap="sm">
          {visibleResults.map((result) => (
            <Card
              key={`${result.kind}-${result.id}`}
              withBorder
              padding="md"
              radius="sm"
              className={searchStyles.mobileResult}
              data-clickable={result.kind !== "ACTIVITY" || undefined}
              {...resultInteraction(result)}
            >
              <Group justify="space-between" wrap="nowrap" mb="xs">
                {kindBadge(result.kind)}
                <Text size="xs" c="dimmed" className={searchStyles.dateText}>
                  {new Date(result.createdAt).toLocaleDateString(intl.locale)}
                </Text>
              </Group>
              <Group align="flex-start" wrap="nowrap" gap="xs">
                <Text
                  className={searchStyles.mobileResultName}
                  size="sm"
                  fw={600}
                  lineClamp={2}
                >
                  {result.name}
                </Text>
                {result.kind !== "ACTIVITY" && (
                  <TbChevronRight
                    className={searchStyles.chevron}
                    size={17}
                    aria-hidden="true"
                  />
                )}
              </Group>
              <Group
                justify="space-between"
                align="center"
                wrap="nowrap"
                mt={6}
              >
                <Text
                  className={searchStyles.secondaryText}
                  size="xs"
                  c="dimmed"
                  lineClamp={1}
                >
                  {result.secondary || "-"}
                </Text>
                {result.status && (
                  <Badge size="xs" variant="outline">
                    {signatureStatusLabel(result.status)}
                  </Badge>
                )}
              </Group>
            </Card>
          ))}
        </Stack>
      ) : (
        <Paper withBorder radius="sm" className={searchStyles.tableShell}>
          <Table
            striped
            highlightOnHover
            verticalSpacing="sm"
            className={searchStyles.resultsTable}
          >
            <colgroup>
              <col className={searchStyles.nameColumn} />
              <col className={searchStyles.contextColumn} />
              <col className={searchStyles.statusColumn} />
              <col className={searchStyles.dateColumn} />
            </colgroup>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("team.search.table.name")}</Table.Th>
                <Table.Th>{t("team.search.table.context")}</Table.Th>
                <Table.Th>{t("team.search.table.status")}</Table.Th>
                <Table.Th>{t("team.search.table.date")}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visibleResults.map((result) => (
                <Table.Tr
                  key={`${result.kind}-${result.id}`}
                  className={searchStyles.resultRow}
                  data-clickable={result.kind !== "ACTIVITY" || undefined}
                  {...resultInteraction(result)}
                >
                  <Table.Td>
                    <Group wrap="nowrap" gap="sm">
                      {kindIcon(result.kind)}
                      <Box className={searchStyles.resultIdentity}>
                        <Text size="sm" fw={600} truncate title={result.name}>
                          {result.name}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {resultKindLabel(result.kind)}
                        </Text>
                      </Box>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Text
                      className={searchStyles.cellText}
                      size="xs"
                      c="dimmed"
                      truncate
                      title={result.secondary || "-"}
                    >
                      {result.secondary || "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {result.status ? (
                      <Badge size="xs" variant="outline">
                        {signatureStatusLabel(result.status)}
                      </Badge>
                    ) : (
                      <Text c="dimmed">-</Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text
                      className={searchStyles.dateText}
                      size="xs"
                      c="dimmed"
                    >
                      {new Date(result.createdAt).toLocaleDateString(
                        intl.locale,
                      )}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
      {results.length > resultPageSize && (
        <Group justify="center" mt="xs">
          <Pagination
            value={Math.min(resultPage, resultPageCount)}
            onChange={setResultPage}
            total={resultPageCount}
            withEdges
          />
        </Group>
      )}
    </Stack>
  );
};

// Team Shares Panel (sub-component)
// ============================================================================

const TeamSharesPanel = ({ teamId }: { teamId: string }) => {
  const router = useRouter();
  const isMobile = useMediaQuery("(max-width: 680px)");
  const [receivedPage, setReceivedPage] = useState(1);
  const [sentPage, setSentPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ["team-shares", teamId, receivedPage, sentPage],
    queryFn: () => getTeamShares(teamId, { receivedPage, sentPage, limit: 25 }),
    enabled: !!teamId,
    staleTime: 30_000,
  });

  const navigateToFile = (folderId: string, fileId: string) => {
    router.push(`/team/${teamId}/folder/${folderId}?highlight=${fileId}`);
  };

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  if (isLoading) {
    return (
      <Box p="lg" ta="center">
        <Loader size="sm" />
      </Box>
    );
  }

  const received = data?.received || [];
  const sent = data?.sent || [];

  return (
    <Stack gap="xl">
      {/* Received shares */}
      <Box>
        <Title order={4} mb="sm">
          <Group gap="xs">
            <TbDownload size={18} />
            Partages reçus ({data?.pagination.received.total || 0})
          </Group>
        </Title>
        {received.length === 0 ? (
          <Text size="sm" c="dimmed">
            Aucun partage reçu dans cette équipe.
          </Text>
        ) : isMobile ? (
          <Stack gap="sm">
            {received.map((share) => (
              <Card key={share.id} withBorder padding="sm" radius="md">
                <Text
                  size="sm"
                  fw={600}
                  lineClamp={1}
                  mb={4}
                  style={{ overflowWrap: "anywhere", hyphens: "auto" }}
                >
                  {share.fileInfo?.fileName || "-"}
                </Text>
                <Group gap="xs" mb={4}>
                  <Badge
                    variant="light"
                    size="sm"
                    leftSection={<TbFolder size={12} />}
                  >
                    {share.fileInfo?.folderName || "-"}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed" mb={2}>
                  {share.grantor?.username || share.grantor?.email || "-"}
                </Text>
                <Group justify="space-between" align="center">
                  <Text size="xs" c="dimmed">
                    {formatDate(share.createdAt)}
                  </Text>
                  {share.fileInfo?.folderId && (
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      onClick={() =>
                        navigateToFile(
                          share.fileInfo!.folderId!,
                          share.fileInfo!.fileId,
                        )
                      }
                    >
                      <TbFolder size={16} />
                    </ActionIcon>
                  )}
                </Group>
              </Card>
            ))}
          </Stack>
        ) : (
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Fichier</Table.Th>
                <Table.Th>Dossier</Table.Th>
                <Table.Th>Partagé par</Table.Th>
                <Table.Th>Date</Table.Th>
                <Table.Th>Accès</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {received.map((share) => (
                <Table.Tr key={share.id}>
                  <Table.Td>
                    <Text
                      size="sm"
                      fw={500}
                      lineClamp={1}
                      style={{ overflowWrap: "anywhere", hyphens: "auto" }}
                    >
                      {share.fileInfo?.fileName || "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      variant="light"
                      size="sm"
                      leftSection={<TbFolder size={12} />}
                    >
                      {share.fileInfo?.folderName || "-"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {share.grantor?.username || share.grantor?.email || "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {formatDate(share.createdAt)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {share.fileInfo?.folderId && (
                      <Tooltip label="Ouvrir le fichier">
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          onClick={() =>
                            navigateToFile(
                              share.fileInfo!.folderId!,
                              share.fileInfo!.fileId,
                            )
                          }
                        >
                          <TbFolder size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        {(data?.pagination.received.totalPages || 0) > 1 && (
          <Group justify="center" mt="md">
            <Pagination
              value={receivedPage}
              onChange={setReceivedPage}
              total={data?.pagination.received.totalPages || 1}
              withEdges
            />
          </Group>
        )}
      </Box>

      <Divider />

      {/* Sent shares */}
      <Box>
        <Title order={4} mb="sm">
          <Group gap="xs">
            <TbShare size={18} />
            Partages effectués ({data?.pagination.sent.total || 0})
          </Group>
        </Title>
        {sent.length === 0 ? (
          <Text size="sm" c="dimmed">
            Aucun partage effectué dans cette équipe.
          </Text>
        ) : isMobile ? (
          <Stack gap="sm">
            {sent.map((share) => (
              <Card key={share.id} withBorder padding="sm" radius="md">
                <Text
                  size="sm"
                  fw={600}
                  lineClamp={1}
                  mb={4}
                  style={{ overflowWrap: "anywhere", hyphens: "auto" }}
                >
                  {share.fileInfo?.fileName || "-"}
                </Text>
                <Group gap="xs" mb={4}>
                  <Badge
                    variant="light"
                    size="sm"
                    leftSection={<TbFolder size={12} />}
                  >
                    {share.fileInfo?.folderName || "-"}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed" mb={2}>
                  {share.recipient?.username || share.recipient?.email || "-"}
                </Text>
                <Group justify="space-between" align="center">
                  <Text size="xs" c="dimmed">
                    {formatDate(share.createdAt)}
                  </Text>
                  {share.fileInfo?.folderId && (
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      onClick={() =>
                        navigateToFile(
                          share.fileInfo!.folderId!,
                          share.fileInfo!.fileId,
                        )
                      }
                    >
                      <TbFolder size={16} />
                    </ActionIcon>
                  )}
                </Group>
              </Card>
            ))}
          </Stack>
        ) : (
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Fichier</Table.Th>
                <Table.Th>Dossier</Table.Th>
                <Table.Th>Partagé avec</Table.Th>
                <Table.Th>Date</Table.Th>
                <Table.Th>Accès</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {sent.map((share) => (
                <Table.Tr key={share.id}>
                  <Table.Td>
                    <Text size="sm" fw={500} lineClamp={1}>
                      {share.fileInfo?.fileName || "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      variant="light"
                      size="sm"
                      leftSection={<TbFolder size={12} />}
                    >
                      {share.fileInfo?.folderName || "-"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {share.recipient?.username ||
                        share.recipient?.email ||
                        "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {formatDate(share.createdAt)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {share.fileInfo?.folderId && (
                      <Tooltip label="Ouvrir le fichier">
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          onClick={() =>
                            navigateToFile(
                              share.fileInfo!.folderId!,
                              share.fileInfo!.fileId,
                            )
                          }
                        >
                          <TbFolder size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        {(data?.pagination.sent.totalPages || 0) > 1 && (
          <Group justify="center" mt="md">
            <Pagination
              value={sentPage}
              onChange={setSentPage}
              total={data?.pagination.sent.totalPages || 1}
              withEdges
            />
          </Group>
        )}
      </Box>
    </Stack>
  );
};

export default TeamDashboard;
