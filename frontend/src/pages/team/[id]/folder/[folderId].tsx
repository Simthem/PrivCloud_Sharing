import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/router";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useModals } from "@mantine/modals";
import { useMediaQuery } from "@mantine/hooks";
import { useIntl } from "react-intl";
import useTranslate from "../../../../hooks/useTranslate.hook";
import "@mantine/core/styles/Switch.css";
import {
  ActionIcon,
  Badge,
  Box,
  Breadcrumbs,
  Button,
  Card,
  Checkbox,
  Container,
  Divider,
  Group,
  Loader,
  Modal,
  MultiSelect,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  TbArrowLeft,
  TbArrowsSort,
  TbChevronDown,
  TbChevronRight,
  TbCheck,
  TbCloudUpload,
  TbCopy,
  TbDownload,
  TbEye,
  TbExternalLink,
  TbFile,
  TbFilter,
  TbFolder,
  TbKey,
  TbLock,
  TbQrcode,
  TbShieldCheck,
  TbSignature,
  TbSortAscending,
  TbSortDescending,
  TbTrash,
  TbUserPlus,
} from "react-icons/tb";
import Meta from "../../../../components/Meta";
import RequestSignatureModal from "../../../../components/signing/RequestSignatureModal";
import E2EShareModal from "../../../../components/team/E2EShareModal";
import teamService from "../../../../services/team.service";
import shareService from "../../../../services/share.service";
import showFilePreviewModal from "../../../../components/share/modals/showFilePreviewModal";
import useConfig from "../../../../hooks/config.hook";
import useUser from "../../../../hooks/user.hook";
import { copyToClipboard } from "../../../../utils/clipboard.util";
import toast from "../../../../utils/toast.util";
import { byteToHumanSizeString } from "../../../../utils/fileSize.util";
import {
  buildFileTree,
  flattenFileTree,
  hasNestedFilePaths,
  type FileTreeFolderNode,
  type FileTreeItem,
  type FileTreeNode,
} from "../../../../utils/fileTree.util";
import { getFileDisplayPath } from "../../../../utils/uploadPath.util";
import { getTeamFolderContentQueryKeys } from "../../../../utils/teamQuery.util";
import dayjs from "../../../../utils/dayjs";
import {
  getUserKey,
  importKeyFromBase64,
  exportKeyToBase64,
  unwrapReverseShareKey,
  buildKeyFragment,
} from "../../../../utils/crypto.util";
import showQrCodeModal from "../../../../components/core/showQrCodeModal";
import showShareLinkModal from "../../../../components/account/showShareLinkModal";

type TeamFolderFile = FileTreeItem & {
  shareId: string;
  shareName: string;
  size: string;
  createdAt: string;
  creatorEmail?: string;
  creatorId?: string;
  isE2EEncrypted: boolean;
};

const TeamFolderPage = () => {
  const router = useRouter();
  const intl = useIntl();
  const t = useTranslate();
  const config = useConfig();
  const queryClient = useQueryClient();
  const { user } = useUser();
  const modals = useModals();
  const isMobile = useMediaQuery("(max-width: 680px)");
  const { id: teamId, folderId, highlight } = router.query;
  const teamIdStr = Array.isArray(teamId) ? teamId[0] : teamId || "";
  const folderIdStr = Array.isArray(folderId) ? folderId[0] : folderId || "";
  const highlightFileId = Array.isArray(highlight) ? highlight[0] : highlight || "";

  // Highlight animation: remove after 2s
  const [activeHighlight, setActiveHighlight] = useState<string>("");
  useEffect(() => {
    if (highlightFileId) {
      setActiveHighlight(highlightFileId);
      const fadeTimer = setTimeout(() => setActiveHighlight(""), 2000);
      return () => clearTimeout(fadeTimer);
    }
  }, [highlightFileId]);

  const [sigModalData, setSigModalData] = useState<{
    shareId: string;
    files: { id: string; name: string }[];
  } | null>(null);

  // E2EE share modal state
  const [e2eShareFiles, setE2eShareFiles] = useState<
    { fileId: string; teamFileId?: string; shareId: string; name: string; uploadedByUserId?: string }[]
  >([]);
  const [e2eShareOpen, setE2eShareOpen] = useState(false);

  const [accessModalOpen, setAccessModalOpen] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [selectedPermission, setSelectedPermission] = useState<string>("READ");
  const [accessCanSign, setAccessCanSign] = useState(false);
  const [accessCanShareE2E, setAccessCanShareE2E] = useState(false);
  // File selection state
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  // File permissions modal
  const [filePermsModalOpen, setFilePermsModalOpen] = useState(false);
  const [filePermMembers, setFilePermMembers] = useState<
    Record<string, string>
  >({}); // memberId -> permission
  const [filePermSign, setFilePermSign] = useState<
    Record<string, boolean>
  >({}); // memberId -> canRequestSignature
  const [filePermE2E, setFilePermE2E] = useState<
    Record<string, boolean>
  >({}); // memberId -> canShareE2E

  // E2E: resolved team key for preview/download
  const [teamKeyB64, setTeamKeyB64] = useState<string | null>(null);

  // Sorting & filtering state
  const [sortField, setSortField] = useState<"name" | "size" | "date" | "uploader">("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filterExtensions, setFilterExtensions] = useState<string[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );

  const toggleFolder = (folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  // Resolve team E2E key on mount
  useEffect(() => {
    if (!teamIdStr) return;
    let cancelled = false;
    (async () => {
      try {
        const userKeyB64 = getUserKey();
        if (!userKeyB64) return;
        const { wrappedTeamKey } = await teamService.getTeamKey(teamIdStr);
        if (cancelled || !wrappedTeamKey) return;
        const masterKey = await importKeyFromBase64(userKeyB64);
        const teamKey = await unwrapReverseShareKey(wrappedTeamKey, masterKey);
        const keyB64 = await exportKeyToBase64(teamKey);
        if (!cancelled) setTeamKeyB64(keyB64);
      } catch (e) {
        console.warn("[E2E] Failed to resolve team key:", e);
        // Fallback: try user's own key for files they uploaded themselves
        const userKeyB64 = getUserKey();
        if (!cancelled && userKeyB64) setTeamKeyB64(userKeyB64);
      }
    })();
    return () => { cancelled = true; };
  }, [teamIdStr]);

  const { data, isLoading } = useQuery({
    queryKey: ["team.folder.shares", teamIdStr, folderIdStr],
    queryFn: () => teamService.getFolderShares(teamIdStr, folderIdStr),
    enabled: !!teamIdStr && !!folderIdStr,
  });

  // Scroll to highlighted file once data is loaded
  useEffect(() => {
    if (highlightFileId && data) {
      const timer = setTimeout(() => {
        const el = document.getElementById(`team-file-${highlightFileId}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [highlightFileId, data]);

  // Get team details to determine role and members list
  const { data: team } = useQuery({
    queryKey: ["team", teamIdStr],
    queryFn: () => teamService.getTeam(teamIdStr),
    enabled: !!teamIdStr,
  });

  // Get folder access rules (only for admin/owner)
  const myMembership = team?.members?.find((m: any) => m.user?.id === user?.id);
  const isTeamAdmin = myMembership?.role === "OWNER" || myMembership?.role === "ADMIN";

  const { data: accessRules } = useQuery({
    queryKey: ["team.folder.access", teamIdStr, folderIdStr],
    queryFn: () => teamService.getFolderAccess(teamIdStr, folderIdStr),
    enabled: !!teamIdStr && !!folderIdStr && isTeamAdmin,
  });

  // Get file-level access rules (only for admin/owner)
  const { data: fileAccessRules } = useQuery({
    queryKey: ["team.folder.fileAccess", teamIdStr, folderIdStr],
    queryFn: () => teamService.getFileAccess(teamIdStr, folderIdStr),
    enabled: !!teamIdStr && !!folderIdStr && isTeamAdmin,
  });

  // Determine folder-level write permission for the current user
  const myFolderAccess = accessRules?.find(
    (rule: any) => rule.memberId === myMembership?.id,
  );
  // myAccess from the backend response (available for non-admins)
  const serverAccess = data?.myAccess;
  const myFileAccess = data?.myFileAccess || {};
  const myPermission = isTeamAdmin ? "ADMIN" : (myFolderAccess?.permission || serverAccess?.permission || "READ");

  // Resolve effective permission for a given file.
  // File-level access OVERRIDES folder-level when it exists.
  const resolveFilePerms = (fileId: string) => {
    if (isTeamAdmin) return { canDownload: true, canDelete: true, canDeleteOnlyOwn: false, canSign: true, canShare: true, canShareE2E: true };
    const fa = myFileAccess[fileId];
    if (fa) {
      // File-level override
      const perm = fa.permission;
      return {
        canDownload: perm !== "NONE" && perm !== "DENY",
        canDelete: perm === "WRITE" || perm === "ADMIN",
        canDeleteOnlyOwn: perm === "WRITE",
        canSign: perm === "DENY" ? false : fa.canRequestSignature,
        // DENY = accès interdit -> le partage (lien public, clé E2E) est aussi bloqué
        canShare: perm !== "NONE" && perm !== "DENY",
        canShareE2E: perm === "DENY" ? false : !!fa.canShareE2E,
      };
    }
    // Fallback to folder-level
    return {
      canDownload: myPermission !== "NONE",
      canDelete: myPermission === "WRITE" || myPermission === "ADMIN",
      canDeleteOnlyOwn: myPermission === "WRITE",
      canSign: serverAccess?.canRequestSignature === true,
      canShare: myPermission !== "NONE",
      canShareE2E: serverAccess?.canShareE2E === true,
    };
  };

  // Folder-level flags (used for UI sections like upload, bulk actions)
  const canWrite = isTeamAdmin || myPermission === "WRITE" || myPermission === "ADMIN";
  const canShareE2E = isTeamAdmin || serverAccess?.canShareE2E === true;
  const _canDownloadFolder = isTeamAdmin || myPermission !== "NONE";

  const invalidateFolderContentQueries = () => {
    void Promise.all(
      getTeamFolderContentQueryKeys(teamIdStr, folderIdStr).map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
  };

  const addAccessMutation = useMutation({
    mutationFn: (data: { memberId: string; permission: string; canRequestSignature?: boolean; canShareE2E?: boolean }) =>
      teamService.setFolderAccess(teamIdStr, folderIdStr, data),
    onSuccess: () => {
      toast.success(t("team.folder.toast.accessUpdated"));
      queryClient.invalidateQueries({ queryKey: ["team.folder.access", teamIdStr, folderIdStr] });
      queryClient.invalidateQueries({ queryKey: ["team.folder.shares", teamIdStr, folderIdStr] });
      setAccessModalOpen(false);
      setSelectedMemberId(null);
      setSelectedPermission("READ");
      setAccessCanSign(false);
      setAccessCanShareE2E(false);
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || t("team.folder.toast.error")),
  });

  const removeAccessMutation = useMutation({
    mutationFn: (memberId: string) =>
      teamService.removeFolderAccess(teamIdStr, folderIdStr, memberId),
    onSuccess: () => {
      toast.success(t("team.folder.toast.accessRemoved"));
      queryClient.invalidateQueries({ queryKey: ["team.folder.access", teamIdStr, folderIdStr] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || t("team.folder.toast.error")),
  });

  const deleteFileMutation = useMutation({
    mutationFn: ({ shareId, fileId }: { shareId: string; fileId: string }) =>
      shareService.removeFile(shareId, fileId),
    onSuccess: () => {
      toast.success(t("team.folder.toast.fileDeleted"));
      invalidateFolderContentQueries();
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || t("team.folder.toast.deleteError")),
  });

  const deleteShareMutation = useMutation({
    mutationFn: (shareId: string) => shareService.remove(shareId),
    onSuccess: () => {
      toast.success(t("team.folder.toast.shareDeleted"));
      invalidateFolderContentQueries();
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || t("team.folder.toast.deleteError")),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (files: { shareId: string; fileId: string }[]) =>
      teamService.bulkDeleteFiles(teamIdStr, folderIdStr, files),
    onSuccess: (result) => {
      toast.success(t("team.folder.toast.bulkDeleted", { count: result.deleted }));
      setSelectedFiles(new Set());
      invalidateFolderContentQueries();
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || t("team.folder.toast.error")),
  });

  const setFileAccessMutation = useMutation({
    mutationFn: (data: {
      fileIds: string[];
      members: { memberId: string; permission: string; canRequestSignature?: boolean; canShareE2E?: boolean }[];
    }) => teamService.setFileAccess(teamIdStr, folderIdStr, data),
    onSuccess: (result) => {
      toast.success(t("team.folder.toast.filePermsApplied", { files: result.filesCount, members: result.membersCount }));
      setFilePermsModalOpen(false);
      setFilePermMembers({});
      setFilePermSign({});
      setFilePermE2E({});
      setSelectedFiles(new Set());
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || t("team.folder.toast.error")),
  });

  const confirmDeleteFile = (shareId: string, fileId: string, fileName: string) => {
    modals.openConfirmModal({
      title: t("team.folder.confirmDelete.fileTitle"),
      children: (
        <Text size="sm">
          {t("team.folder.confirmDelete.fileBody", { name: fileName })}
        </Text>
      ),
      labels: { confirm: t("team.folder.confirmDelete.confirm"), cancel: t("team.folder.confirmDelete.cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteFileMutation.mutate({ shareId, fileId }),
    });
  };

  const confirmDeleteShare = (shareId: string, shareName: string) => {
    modals.openConfirmModal({
      title: t("team.folder.confirmDelete.shareTitle"),
      children: (
        <Text size="sm">
          {t("team.folder.confirmDelete.shareBody", { name: shareName })}
        </Text>
      ),
      labels: { confirm: t("team.folder.confirmDelete.confirm"), cancel: t("team.folder.confirmDelete.cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteShareMutation.mutate(shareId),
    });
  };

  const toggleFileSelection = (fileKey: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileKey)) next.delete(fileKey);
      else next.add(fileKey);
      return next;
    });
  };

  // Flatten all files from all shares for display (must be before early return to satisfy hooks rules)
  const allFiles = useMemo<TeamFolderFile[]>(() => {
    if (!data) return [];
    return data.shares.flatMap((share) =>
      share.files.map((file) => ({
        ...file,
        shareId: share.id,
        shareName: share.name || share.id,
        creatorEmail: share.creator?.email,
        creatorId: share.creator?.id,
        isE2EEncrypted: share.isE2EEncrypted,
      }))
    );
  }, [data]);

  // Extract unique file extensions for filter options
  const availableExtensions = useMemo(() => {
    const extSet = new Set<string>();
    allFiles.forEach((f) => {
      const match = f.name?.match(/\.([a-zA-Z0-9]+)$/);
      if (match) extSet.add(match[1].toLowerCase());
    });
    return Array.from(extSet).sort().map((ext) => ({ value: ext, label: `.${ext}` }));
  }, [allFiles]);

  // Filtered + sorted files
  const filteredSortedFiles = useMemo(() => {
    let result = [...allFiles];
    // Filter by extension
    if (filterExtensions.length > 0) {
      result = result.filter((f) => {
        const match = f.name?.match(/\.([a-zA-Z0-9]+)$/);
        return match && filterExtensions.includes(match[1].toLowerCase());
      });
    }
    // Sort
    result.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "name":
          cmp = getFileDisplayPath(a).localeCompare(getFileDisplayPath(b), undefined, {
            numeric: true,
          });
          break;
        case "size":
          cmp = parseInt(a.size || "0") - parseInt(b.size || "0");
          break;
        case "date":
          cmp = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
          break;
        case "uploader":
          cmp = (a.creatorEmail || "").localeCompare(b.creatorEmail || "");
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return result;
  }, [allFiles, sortField, sortDir, filterExtensions]);

  const shouldUseTree = useMemo(
    () => hasNestedFilePaths(filteredSortedFiles),
    [filteredSortedFiles],
  );
  const fileTree = useMemo(
    () => (shouldUseTree ? buildFileTree(filteredSortedFiles) : []),
    [filteredSortedFiles, shouldUseTree],
  );
  const visibleTreeNodes = useMemo(
    () => flattenFileTree(fileTree, collapsedFolders),
    [fileTree, collapsedFolders],
  );
  const visibleFileNodes = useMemo<FileTreeNode<TeamFolderFile>[]>(() => {
    if (shouldUseTree) return visibleTreeNodes;

    return filteredSortedFiles.map((file) => ({
      type: "file" as const,
      key: `file:${file.shareId}-${file.id}`,
      name: file.name,
      path: file.name,
      depth: 0,
      file,
    }));
  }, [filteredSortedFiles, shouldUseTree, visibleTreeNodes]);

  if (isLoading || !data) {
    return (
      <Container size="lg" mt="xl" px={0}>
        <Box ta="center" py="xl">
          <Loader size="lg" />
        </Box>
      </Container>
    );
  }

  const { folder, shares } = data;

  const allSelected = allFiles.length > 0 && allFiles.every((f) => selectedFiles.has(`${f.shareId}-${f.id}`));
  const someSelected = selectedFiles.size > 0;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(allFiles.map((f) => `${f.shareId}-${f.id}`)));
    }
  };

  const confirmBulkDelete = () => {
    const filesToDelete = allFiles
      .filter((f) => selectedFiles.has(`${f.shareId}-${f.id}`))
      .map((f) => ({ shareId: f.shareId, fileId: f.id }));
    if (filesToDelete.length === 0) return;
    modals.openConfirmModal({
      title: t("team.folder.confirmDelete.bulkTitle"),
      children: (
        <Text size="sm">
          {t("team.folder.confirmDelete.bulkBody", { count: filesToDelete.length })}
        </Text>
      ),
      labels: { confirm: t("team.folder.confirmDelete.confirm"), cancel: t("team.folder.confirmDelete.cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => bulkDeleteMutation.mutate(filesToDelete),
    });
  };

  const openFilePermsModal = () => {
    // Pre-initialize MEMBER role members only (admins/owners have full access)
    const initial: Record<string, string> = {};
    const initialSign: Record<string, boolean> = {};
    const initialE2E: Record<string, boolean> = {};
    team?.members
      ?.filter((m: any) => m.role === "MEMBER" && m.isActive)
      ?.forEach((m: any) => {
        initial[m.id] = ""; // empty = not selected
        initialSign[m.id] = false;
        initialE2E[m.id] = false;
      });
    setFilePermMembers(initial);
    setFilePermSign(initialSign);
    setFilePermE2E(initialE2E);
    setFilePermsModalOpen(true);
  };

  const submitFilePerms = () => {
    const fileIds = allFiles
      .filter((f) => selectedFiles.has(`${f.shareId}-${f.id}`))
      .map((f) => f.id);
    const members = Object.entries(filePermMembers)
      .filter(([, perm]) => perm !== "")
      .map(([memberId, permission]) => ({
        memberId,
        permission,
        canRequestSignature: (permission === "NONE" || permission === "DENY") ? false : (filePermSign[memberId] ?? false),
        canShareE2E: (permission === "NONE" || permission === "DENY") ? false : (filePermE2E[memberId] ?? false),
      }));
    if (fileIds.length === 0 || members.length === 0) return;
    setFileAccessMutation.mutate({ fileIds, members });
  };

  const renderMobileFolderCard = (
    folderNode: FileTreeFolderNode<TeamFolderFile>,
  ) => {
    const collapsed = collapsedFolders.has(folderNode.path);

    return (
      <Card
        key={folderNode.key}
        withBorder
        padding="xs"
        radius="md"
        style={{ marginLeft: folderNode.depth * 18 }}
      >
        <Group
          gap="xs"
          wrap="nowrap"
          onClick={() => toggleFolder(folderNode.path)}
          style={{ cursor: "pointer" }}
        >
          <ActionIcon variant="subtle" size={24}>
            {collapsed ? (
              <TbChevronRight size={16} />
            ) : (
              <TbChevronDown size={16} />
            )}
          </ActionIcon>
          <TbFolder
            size={18}
            color={folder.color || "var(--mantine-color-blue-6)"}
            style={{ flexShrink: 0 }}
          />
          <Text size="sm" fw={700} truncate="end" style={{ minWidth: 0 }}>
            {folderNode.name}
          </Text>
          <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
            {t("fileTree.items", { count: folderNode.fileCount })}
          </Text>
        </Group>
      </Card>
    );
  };

  const renderDesktopFolderRow = (
    folderNode: FileTreeFolderNode<TeamFolderFile>,
  ) => {
    const collapsed = collapsedFolders.has(folderNode.path);

    return (
      <Table.Tr key={folderNode.key}>
        {isTeamAdmin && <Table.Td />}
        <Table.Td>
          <Group
            gap="xs"
            wrap="nowrap"
            onClick={() => toggleFolder(folderNode.path)}
            style={{
              cursor: "pointer",
              paddingLeft: folderNode.depth * 22,
              minWidth: 0,
            }}
          >
            <ActionIcon variant="subtle" size={24}>
              {collapsed ? (
                <TbChevronRight size={16} />
              ) : (
                <TbChevronDown size={16} />
              )}
            </ActionIcon>
            <TbFolder
              size={18}
              color={folder.color || "var(--mantine-color-blue-6)"}
              style={{ flexShrink: 0 }}
            />
            <Text size="sm" fw={700} truncate="end" style={{ minWidth: 0 }}>
              {folderNode.name}
            </Text>
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              {t("fileTree.items", { count: folderNode.fileCount })}
            </Text>
          </Group>
        </Table.Td>
        <Table.Td />
        <Table.Td />
        <Table.Td />
        <Table.Td />
      </Table.Tr>
    );
  };

  return (
    <>
      <Meta title={`${t("team.folder.breadcrumb.folders")} – ${folder.name}`} />
      <Container size="lg" mt="xl" px={0}>
        <Breadcrumbs mb="md">
          <Link
            href={`/team/${teamIdStr}?tab=folders`}
            style={{ textDecoration: "none", color: "inherit" }}
          >
            <Group gap={4}>
              <TbArrowLeft size={14} />
              <Text size="sm">{t("team.folder.breadcrumb.team")}</Text>
            </Group>
          </Link>
          <Text size="sm" c="dimmed">
            {t("team.folder.breadcrumb.folders")}
          </Text>
          <Text size="sm" fw={500}>
            {folder.name}
          </Text>
        </Breadcrumbs>

        <Group mb="lg" align="center" gap="sm" justify="space-between">
          <Group gap="sm" align="center">
            <TbFolder
              size={28}
              color={folder.color || "var(--mantine-color-blue-6)"}
            />
            <Title order={2}>{folder.name}</Title>
            {folder.description && (
              <Text size="sm" c="dimmed" ml="sm">
                {folder.description}
              </Text>
            )}
          </Group>
          {canWrite && (
            <Button
              size="sm"
              leftSection={<TbCloudUpload size={16} />}
              onClick={() => router.push(`/upload?teamFolderId=${folderIdStr}&teamId=${teamIdStr}`)}
            >
              {t("team.folder.uploadButton")}
            </Button>
          )}
        </Group>

        {allFiles.length === 0 ? (
          <Card withBorder p="xl" ta="center">
            <Stack align="center" gap="sm">
              <TbFile size={40} color="gray" />
              <Text c="dimmed">
                {t("team.folder.empty")}
              </Text>
            </Stack>
          </Card>
        ) : (
          <>
            {/* Toolbar: sort & filter */}
            <Group mb="sm" gap="sm" wrap="wrap" align="flex-end">
              <Select
                size="xs"
                w={160}
                leftSection={<TbArrowsSort size={14} />}
                label={t("team.folder.sort.label")}
                value={sortField}
                onChange={(v) => v && setSortField(v as typeof sortField)}
                data={[
                  { value: "name", label: t("team.folder.sort.name") },
                  { value: "size", label: t("team.folder.sort.size") },
                  { value: "date", label: t("team.folder.sort.date") },
                  { value: "uploader", label: t("team.folder.sort.uploader") },
                ]}
              />
              <Tooltip label={sortDir === "asc" ? t("team.folder.sort.toDescending") : t("team.folder.sort.toAscending")}>
                <ActionIcon
                  variant="light"
                  size={30}
                  onClick={() => setSortDir((d) => d === "asc" ? "desc" : "asc")}
                  mt={22}
                >
                  {sortDir === "asc" ? <TbSortDescending size={16} /> : <TbSortAscending size={16} />}
                </ActionIcon>
              </Tooltip>
              {availableExtensions.length > 1 && (
                <MultiSelect
                  size="xs"
                  w={240}
                  leftSection={<TbFilter size={14} />}
                  label={t("team.folder.filter.label")}
                  placeholder={t("team.folder.filter.placeholder")}
                  data={availableExtensions}
                  value={filterExtensions}
                  onChange={setFilterExtensions}
                  clearable
                  searchable
                />
              )}
              {filterExtensions.length > 0 && (
                <Text size="xs" c="dimmed" mt={22}>
                  {t("team.folder.filter.showing", { count: filteredSortedFiles.length, total: allFiles.length })}
                </Text>
              )}
            </Group>

            {filteredSortedFiles.length === 0 ? (
              <Card withBorder p="lg" ta="center">
                <Text c="dimmed" size="sm">{t("team.folder.filter.noResults")}</Text>
              </Card>
            ) : isMobile ? (
          <Stack gap="sm">
            {visibleFileNodes.map((node) => {
              if (node.type === "folder") {
                return renderMobileFolderCard(node);
              }

              const file = node.file;
              const isPdf = /\.pdf$/i.test(file.name || "");
              const fp = resolveFilePerms(file.id);
              const isHighlighted = activeHighlight === file.id;
              return (
                <Card
                  id={`team-file-${file.id}`}
                  key={`${file.shareId}-${file.id}`}
                  withBorder
                  padding="sm"
                  radius="md"
                  style={isHighlighted ? {
                    boxShadow: "0 0 0 2px var(--mantine-color-blue-5)",
                    transition: "box-shadow 0.5s ease",
                    marginLeft: node.depth * 18,
                  } : {
                    transition: "box-shadow 0.5s ease",
                    marginLeft: node.depth * 18,
                  }}
                >
                  <Group justify="space-between" wrap="nowrap" mb={6}>
                    <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: 1 }}>
                      {isTeamAdmin && (
                        <Checkbox
                          size="sm"
                          checked={selectedFiles.has(`${file.shareId}-${file.id}`)}
                          onChange={() => toggleFileSelection(`${file.shareId}-${file.id}`)}
                        />
                      )}
                      <TbFile size={18} color={isPdf ? "var(--mantine-color-red-6)" : undefined} style={{ flexShrink: 0 }} />
                      <Text
                        size="sm"
                        fw={600}
                        lineClamp={1}
                        style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere", hyphens: "auto" }}
                      >
                        {shouldUseTree ? file.name : getFileDisplayPath(file)}
                      </Text>
                      {myFileAccess[file.id] && (
                        <Tooltip label={t("team.folder.fileRights")}>
                          <ThemeIcon size={18} radius="xl" variant="light" color="orange">
                            <TbShieldCheck size={12} />
                          </ThemeIcon>
                        </Tooltip>
                      )}
                    </Group>
                  </Group>
                  <Group gap={8} wrap="wrap" mt={6}>
                    {fp.canDownload && shareService.doesFileSupportPreview(file.name, {
                      fileSizeBytes: parseInt(file.size),
                      isE2EEncrypted: file.isE2EEncrypted,
                    }) && (
                      <ActionIcon
                        variant="light"
                        size={32}
                        color="teal"
                        onClick={() => showFilePreviewModal(file.shareId, file, modals, file.isE2EEncrypted ? teamKeyB64 : null)}
                      >
                        <TbEye size={16} />
                      </ActionIcon>
                    )}
                    <ActionIcon
                      variant="light"
                      size={32}
                      color="blue"
                      disabled={!fp.canDownload}
                      onClick={() =>
                        teamKeyB64
                          ? shareService.downloadFileE2E(file.shareId, file.id, file.name, teamKeyB64)
                          : shareService.downloadFile(file.shareId, file.id)
                      }
                    >
                      <TbDownload size={16} />
                    </ActionIcon>
                    {isPdf && (
                      <ActionIcon
                        variant="light"
                        size={32}
                        color="violet"
                        disabled={!fp.canSign}
                        onClick={() =>
                          setSigModalData({
                            shareId: file.shareId,
                            files: [{ id: file.id, name: file.name }],
                          })
                        }
                      >
                        <TbSignature size={16} />
                      </ActionIcon>
                    )}
                    {teamKeyB64 && file.isE2EEncrypted && fp.canShareE2E && fp.canShare && (
                      <ActionIcon
                        variant="light"
                        size={32}
                        color="teal"
                        onClick={() => {
                          setE2eShareFiles([{ fileId: file.id, shareId: file.shareId, name: file.name, uploadedByUserId: file.creatorId }]);
                          setE2eShareOpen(true);
                        }}
                      >
                        <TbKey size={16} />
                      </ActionIcon>
                    )}
                    <ActionIcon
                      variant="light"
                      size={32}
                      color="red"
                      disabled={!fp.canDelete || (fp.canDeleteOnlyOwn && file.creatorEmail !== user?.email)}
                      onClick={() => confirmDeleteFile(file.shareId, file.id, file.name)}
                      loading={deleteFileMutation.isPending}
                    >
                      <TbTrash size={16} />
                    </ActionIcon>
                  </Group>
                  <Group gap="xs" wrap="wrap" mt={6}>
                    <Text size="xs" c="dimmed">{byteToHumanSizeString(parseInt(file.size))}</Text>
                    <Text size="xs" c="dimmed">-</Text>
                    {fp.canShare ? (
                      <Link href={`/share/${file.shareId}`} style={{ textDecoration: "none" }}>
                        <Badge variant="light" size="xs" rightSection={<TbExternalLink size={9} />}>
                          {file.shareName}
                        </Badge>
                      </Link>
                    ) : (
                      <Badge variant="light" size="xs" color="gray">
                        {file.shareName}
                      </Badge>
                    )}
                    <Text size="xs" c="dimmed">-</Text>
                    <Text size="xs" c="dimmed">{dayjs(file.createdAt).format("L")}</Text>
                  </Group>
                </Card>
              );
            })}
          </Stack>
        ) : (
          <Table striped highlightOnHover style={{ tableLayout: "fixed", width: "100%" }}>
              <Table.Thead>
                <Table.Tr>
                  {isTeamAdmin && (
                    <Table.Th style={{ width: 40 }}>
                      <Checkbox
                        size="sm"
                        checked={allSelected}
                        indeterminate={someSelected && !allSelected}
                        onChange={toggleSelectAll}
                      />
                    </Table.Th>
                  )}
                  <Table.Th>{t("team.folder.table.file")}</Table.Th>
                  <Table.Th style={{ whiteSpace: "nowrap", width: 80 }}>{t("team.folder.table.size")}</Table.Th>
                  <Table.Th style={{ whiteSpace: "nowrap", width: 155 }}>{t("team.folder.table.uploadedBy")}</Table.Th>
                  <Table.Th style={{ whiteSpace: "nowrap", width: 115 }}>{t("team.folder.table.date")}</Table.Th>
                  <Table.Th style={{ whiteSpace: "nowrap", width: 180 }}>{t("team.folder.table.actions")}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {visibleFileNodes.map((node) => {
                  if (node.type === "folder") {
                    return renderDesktopFolderRow(node);
                  }

                  const file = node.file;
                  const isPdf = /\.pdf$/i.test(file.name || "");
                  const fp = resolveFilePerms(file.id);
                  const isHighlighted = activeHighlight === file.id;
                  return (
                    <Table.Tr
                      id={`team-file-${file.id}`}
                      key={`${file.shareId}-${file.id}`}
                      style={isHighlighted ? {
                        backgroundColor: "var(--mantine-color-blue-1)",
                        transition: "background-color 0.5s ease",
                      } : { transition: "background-color 0.5s ease" }}
                    >
                      {isTeamAdmin && (
                        <Table.Td>
                          <Checkbox
                            size="sm"
                            checked={selectedFiles.has(`${file.shareId}-${file.id}`)}
                            onChange={() => toggleFileSelection(`${file.shareId}-${file.id}`)}
                          />
                        </Table.Td>
                      )}
                      <Table.Td>
                        {fp.canShare ? (
                          <Link
                            href={`/share/${file.shareId}`}
                            style={{ textDecoration: "none", color: "inherit" }}
                          >
                            <Group
                              gap="xs"
                              wrap="nowrap"
                              style={{
                                paddingLeft:
                                  shouldUseTree ? node.depth * 22 + 32 : 0,
                                minWidth: 0,
                              }}
                            >
                              {isPdf ? (
                                <TbFile size={18} color="var(--mantine-color-red-6)" />
                              ) : (
                                <TbFile size={16} />
                              )}
                              <Text
                                size="sm"
                                fw={500}
                                lineClamp={1}
                                style={{
                                  cursor: "pointer",
                                  minWidth: 0,
                                  overflowWrap: "anywhere",
                                  hyphens: "auto",
                                }}
                              >
                                {shouldUseTree ? file.name : getFileDisplayPath(file)}
                              </Text>
                              {myFileAccess[file.id] && (
                                <Tooltip label={t("team.folder.fileRights")}>
                                  <ThemeIcon size={18} radius="xl" variant="light" color="orange">
                                    <TbShieldCheck size={12} />
                                  </ThemeIcon>
                                </Tooltip>
                              )}
                            </Group>
                          </Link>
                        ) : (
                          <Group
                            gap="xs"
                            wrap="nowrap"
                            style={{
                              paddingLeft:
                                shouldUseTree ? node.depth * 22 + 32 : 0,
                              minWidth: 0,
                            }}
                          >
                            {isPdf ? (
                              <TbFile size={18} color="var(--mantine-color-red-6)" />
                            ) : (
                              <TbFile size={16} />
                            )}
                            <Text
                              size="sm"
                              fw={500}
                              lineClamp={1}
                              c="dimmed"
                              style={{
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                hyphens: "auto",
                              }}
                            >
                              {shouldUseTree ? file.name : getFileDisplayPath(file)}
                            </Text>
                            {myFileAccess[file.id] && (
                              <Tooltip label={t("team.folder.fileRights")}>
                                <ThemeIcon size={18} radius="xl" variant="light" color="orange">
                                  <TbShieldCheck size={12} />
                                </ThemeIcon>
                              </Tooltip>
                            )}
                          </Group>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          {byteToHumanSizeString(parseInt(file.size))}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Tooltip label={file.creatorEmail || "-"} disabled={!file.creatorEmail}>
                          <Text size="sm" c="dimmed" truncate="end" style={{ maxWidth: 155 }}>
                            {file.creatorEmail || "-"}
                          </Text>
                        </Tooltip>
                      </Table.Td>
                      <Table.Td style={{ whiteSpace: "nowrap" }}>
                        <Text size="xs" c="dimmed">
                          {dayjs(file.createdAt).format("L LT")}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="nowrap">
                          {fp.canDownload && shareService.doesFileSupportPreview(file.name, {
                            fileSizeBytes: parseInt(file.size),
                            isE2EEncrypted: file.isE2EEncrypted,
                          }) && (
                            <Tooltip label={intl.formatMessage({ id: "team.folder.action.preview" })}>
                              <ActionIcon
                                variant="light"
                                size={30}
                                color="teal"
                                onClick={() =>
                                  showFilePreviewModal(file.shareId, file, modals, file.isE2EEncrypted ? teamKeyB64 : null)
                                }
                              >
                                <TbEye size={16} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                          <Tooltip label={intl.formatMessage({ id: "team.folder.action.download" })}>
                            <ActionIcon
                              variant="light"
                              size={30}
                              color="blue"
                              disabled={!fp.canDownload}
                              onClick={() =>
                                teamKeyB64
                                  ? shareService.downloadFileE2E(file.shareId, file.id, file.name, teamKeyB64)
                                  : shareService.downloadFile(file.shareId, file.id)
                              }
                            >
                              <TbDownload size={16} />
                            </ActionIcon>
                          </Tooltip>
                          {isPdf && (
                            <Tooltip label={intl.formatMessage({ id: fp.canSign ? "team.folder.action.request-signature" : "team.folder.action.insufficient-access" })}>
                              <ActionIcon
                                variant="light"
                                size={30}
                                color="violet"
                                disabled={!fp.canSign}
                                onClick={() =>
                                  setSigModalData({
                                    shareId: file.shareId,
                                    files: [{ id: file.id, name: file.name }],
                                  })
                                }
                              >
                                <TbSignature size={16} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                          {teamKeyB64 && file.isE2EEncrypted && fp.canShareE2E && fp.canShare && (
                            <Tooltip label={intl.formatMessage({ id: "team.folder.action.e2eShare" })}>
                              <ActionIcon
                                variant="light"
                                size={30}
                                color="teal"
                                onClick={() => {
                                  setE2eShareFiles([{ fileId: file.id, shareId: file.shareId, name: file.name, uploadedByUserId: file.creatorId }]);
                                  setE2eShareOpen(true);
                                }}
                              >
                                <TbKey size={16} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                          <Tooltip label={intl.formatMessage({ id: fp.canDelete && !(fp.canDeleteOnlyOwn && file.creatorEmail !== user?.email) ? "team.folder.action.delete-file" : "team.folder.action.insufficient-access" })}>
                            <ActionIcon
                              variant="light"
                              size={30}
                              color="red"
                              disabled={!fp.canDelete || (fp.canDeleteOnlyOwn && file.creatorEmail !== user?.email)}
                              onClick={() => confirmDeleteFile(file.shareId, file.id, file.name)}
                              loading={deleteFileMutation.isPending}
                            >
                              <TbTrash size={16} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
            )}
          </>
        )}

        {/* Barre d'actions flottante quand des fichiers sont selectionnes */}
        {isTeamAdmin && someSelected && (
          <Card
            withBorder
            shadow="lg"
            radius="md"
            p="sm"
            mt="md"
            style={{
              position: "sticky",
              bottom: 16,
              zIndex: 100,
              background: "var(--mantine-color-body)",
            }}
          >
            <Group justify="space-between">
              <Text size="sm" fw={500}>
                {t("team.folder.bulkBar.selected", { count: selectedFiles.size })}
              </Text>
              <Group gap="sm">
                <Button
                  size="sm"
                  variant="light"
                  color="red"
                  leftSection={<TbTrash size={16} />}
                  onClick={confirmBulkDelete}
                  loading={bulkDeleteMutation.isPending}
                >
                  {t("team.folder.bulkBar.delete")}
                </Button>
                <Button
                  size="sm"
                  variant="light"
                  color="blue"
                  leftSection={<TbShieldCheck size={16} />}
                  onClick={openFilePermsModal}
                >
                  {t("team.folder.bulkBar.manageRights")}
                </Button>
                {teamKeyB64 && canShareE2E && (
                  <Button
                    size="sm"
                    variant="light"
                    color="teal"
                    leftSection={<TbKey size={16} />}
                    onClick={() => {
                      const filesToShare = allFiles
                        .filter((f) => selectedFiles.has(`${f.shareId}-${f.id}`) && resolveFilePerms(f.id).canShare)
                        .map((f) => ({ fileId: f.id, shareId: f.shareId, name: f.name, uploadedByUserId: f.creatorId }));
                      setE2eShareFiles(filesToShare);
                      setE2eShareOpen(true);
                    }}
                  >
                    {t("team.folder.bulkBar.e2eShare")}
                  </Button>
                )}
              </Group>
            </Group>
          </Card>
        )}

        {/* Partages liés - carte cliquable avec détails */}
        {shares.length > 0 && (
          <Box mt="xl">
            <Title order={4} mb="sm">
              {t("team.folder.shares.title", { count: shares.length })}
            </Title>
            <Stack gap="xs">
              {shares.map((share) => (
                <Link
                  key={share.id}
                  href={`/share/${share.id}`}
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <Card
                    withBorder
                    p="sm"
                    radius="md"
                    style={{
                      cursor: "pointer",
                      transition: "transform 150ms ease, box-shadow 150ms ease",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
                      (e.currentTarget as HTMLElement).style.boxShadow = "var(--mantine-shadow-sm)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.transform = "";
                      (e.currentTarget as HTMLElement).style.boxShadow = "";
                    }}
                  >
                    <Group justify="space-between" wrap="nowrap" align="flex-start">
                      <Box style={{ minWidth: 0, flex: 1 }}>
                        <Group gap="xs" wrap="wrap" align="flex-start" mb={2}>
                          <Text
                            size="sm"
                            fw={600}
                            lineClamp={1}
                            style={{ minWidth: 0, overflowWrap: "anywhere", hyphens: "auto" }}
                          >
                            {share.name || share.id}
                          </Text>
                          <Badge variant="light" size="xs" color="blue" style={{ flexShrink: 0 }}>
                            {t("team.folder.shares.fileCount", { count: share.files.length })}
                          </Badge>
                        </Group>
                        <Text size="xs" c="dimmed" lineClamp={1} style={{ overflowWrap: "anywhere" }}>
                          {share.files.map((f) => f.name).join(", ")}
                        </Text>
                      </Box>
                      <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
                        {share.creator?.email && (
                          <Text size="xs" c="dimmed" visibleFrom="sm">
                            {share.creator.email}
                          </Text>
                        )}
                        <Text size="xs" c="dimmed">
                          {dayjs(share.createdAt).format("L")}
                        </Text>
                        <Tooltip label={t("team.folder.shares.copyLink")}>
                          <ActionIcon
                            variant="light"
                            size={22}
                            color="teal"
                            onClick={async (e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              const keyFragment = share.isE2EEncrypted && teamKeyB64 ? buildKeyFragment(teamKeyB64) : "";
                              const link = `${config.get("general.appUrl")}/s/${share.id}${keyFragment}`;
                              const ok = await copyToClipboard(link);
                              if (ok) toast.success(t("team.folder.shares.linkCopied"));
                              else showShareLinkModal(modals, share.id, keyFragment);
                            }}
                          >
                            <TbCopy size={12} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label={t("team.folder.shares.qrCode")}>
                          <ActionIcon
                            variant="light"
                            size={22}
                            color="grape"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              const keyFragment = share.isE2EEncrypted && teamKeyB64 ? buildKeyFragment(teamKeyB64) : "";
                              const link = `${config.get("general.appUrl")}/s/${share.id}${keyFragment}`;
                              showQrCodeModal(modals, link);
                            }}
                          >
                            <TbQrcode size={12} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label={canWrite ? t("team.folder.shares.deleteTooltip") : intl.formatMessage({ id: "team.folder.action.insufficient-access" })}>
                          <ActionIcon
                            variant="light"
                            size={22}
                            color="red"
                            disabled={!canWrite}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              confirmDeleteShare(share.id, share.name || share.id);
                            }}
                          >
                            <TbTrash size={12} />
                          </ActionIcon>
                        </Tooltip>
                        <TbExternalLink size={14} color="gray" />
                      </Group>
                    </Group>
                  </Card>
                </Link>
              ))}
            </Stack>
          </Box>
        )}

        {/* Section Contrôle d'accès - visible uniquement pour admin/owner */}
        {isTeamAdmin && (
          <Box mt="xl">
            <Divider mb="md" />
            <Group justify="space-between" mb="sm">
              <Group gap="xs">
                <TbLock size={20} />
                <Title order={4}>{t("team.folder.access.title")}</Title>
              </Group>
              <Button
                size="xs"
                variant="light"
                leftSection={<TbUserPlus size={14} />}
                onClick={() => setAccessModalOpen(true)}
              >
                {t("team.folder.access.addButton")}
              </Button>
            </Group>

            {!accessRules || accessRules.length === 0 ? (
              <Card withBorder p="md">
                <Text size="sm" c="dimmed" ta="center">
                  {t("team.folder.access.noRules")}
                </Text>
              </Card>
            ) : (
              <Stack gap="xs">
                {accessRules.filter((rule) => team?.members?.some((m: any) => m.id === rule.memberId)).map((rule) => (
                  <Card key={rule.id} withBorder p="sm" radius="sm">
                    <Group justify="space-between" wrap="nowrap" align="flex-start" mb={4}>
                      <Box style={{ minWidth: 0, flex: 1 }}>
                        <Text
                          size="sm"
                          fw={500}
                          lineClamp={1}
                          style={{ overflowWrap: "anywhere", hyphens: "auto" }}
                        >
                          {rule.user?.username || rule.user?.email || rule.memberId}
                        </Text>
                        {rule.user?.email && (
                          <Text size="xs" c="dimmed">{rule.user.email}</Text>
                        )}
                      </Box>
                      <Group gap="xs" wrap="nowrap">
                        <Badge
                          size="sm"
                          variant="light"
                          color={
                            rule.role === "OWNER" ? "violet" :
                            rule.role === "ADMIN" ? "blue" : "gray"
                          }
                        >
                          {rule.role === "OWNER" ? t("team.folder.access.role.owner") :
                           rule.role === "ADMIN" ? t("team.folder.access.role.admin") : t("team.folder.access.role.member")}
                        </Badge>
                        <Tooltip label={t("team.folder.access.removeTooltip")}>
                          <ActionIcon
                            variant="light"
                            color="red"
                            size="sm"
                            onClick={() => removeAccessMutation.mutate(rule.memberId)}
                            loading={removeAccessMutation.isPending}
                          >
                            <TbTrash size={14} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Group>
                    <Group gap="sm" wrap="wrap" mt={4}>
                      <Select
                        size="xs"
                        w={180}
                        value={rule.permission}
                        onChange={(val) => {
                          if (val === "__DEFAULT__") {
                            removeAccessMutation.mutate(rule.memberId);
                            return;
                          }
                          if (val && val !== rule.permission) {
                            addAccessMutation.mutate({
                              memberId: rule.memberId,
                              permission: val,
                              canRequestSignature: val === "ADMIN" ? true : (val === "NONE" ? false : rule.canRequestSignature),
                              // reset granular flags to defaults when permission level changes
                            });
                          }
                        }}
                        data={[
                          { value: "NONE", label: t("team.folder.permission.none") },
                          { value: "READ", label: t("team.folder.permission.read") },
                          { value: "WRITE", label: t("team.folder.permission.write") },
                          { value: "ADMIN", label: t("team.folder.permission.admin") },
                          { value: "__DEFAULT__", label: t("team.folder.permission.revert") },
                        ]}
                      />
                      {rule.permission !== "NONE" && rule.permission !== "ADMIN" && (
                        <Switch
                          size="sm"
                          color="orange"
                          label={
                            <Group gap={4}>
                              <TbSignature size={14} />
                              <Text size="xs" fw={500}>{t("team.folder.signatureSwitch.short")}</Text>
                            </Group>
                          }
                          checked={rule.canRequestSignature}
                          onChange={(e) => {
                            addAccessMutation.mutate({
                              memberId: rule.memberId,
                              permission: rule.permission,
                              canRequestSignature: e.currentTarget.checked,
                              canShareE2E: rule.canShareE2E,
                            });
                          }}
                        />
                      )}
                      {rule.permission !== "NONE" && rule.permission !== "ADMIN" && (
                        <Switch
                          size="sm"
                          color="teal"
                          label={
                            <Group gap={4}>
                              <TbKey size={14} />
                              <Text size="xs" fw={500}>{t("team.folder.e2eShareSwitch.short")}</Text>
                            </Group>
                          }
                          checked={rule.canShareE2E}
                          onChange={(e) => {
                            addAccessMutation.mutate({
                              memberId: rule.memberId,
                              permission: rule.permission,
                              canRequestSignature: rule.canRequestSignature,
                              canShareE2E: e.currentTarget.checked,
                            });
                          }}
                        />
                      )}
                      {rule.permission === "ADMIN" && (
                        <Badge size="xs" variant="light" color="orange" leftSection={<TbSignature size={12} />}>
                          {t("team.folder.access.fullAccess")}
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed" mt={4}>
                      {rule.permission === "NONE" && t("team.folder.access.desc.none")}
                      {rule.permission === "READ" && t("team.folder.access.desc.read")}
                      {rule.permission === "WRITE" && t("team.folder.access.desc.write")}
                      {rule.permission === "ADMIN" && t("team.folder.access.desc.admin")}
                    </Text>
                  </Card>
                ))}
              </Stack>
            )}

            <Text size="xs" c="dimmed" mt="xs">
              {t("team.folder.access.note")}
            </Text>

            {/* Contrôles d'accès par fichier (groupés par utilisateur) */}
            {fileAccessRules && fileAccessRules.length > 0 && (
              <Box mt="md">
                <Text size="sm" fw={600} mb="xs">{t("team.folder.access.fileLevel.title")}</Text>
                <Stack gap="xs">
                  {(() => {
                    // Group file access rules by user
                    const byUser = new Map<string, { user: any; rules: typeof fileAccessRules }>();
                    for (const rule of fileAccessRules) {
                      const key = rule.user?.email || rule.memberId;
                      if (!byUser.has(key)) byUser.set(key, { user: rule.user, rules: [] });
                      byUser.get(key)!.rules.push(rule);
                    }
                    return Array.from(byUser.entries()).map(([key, { user: ruleUser, rules }]) => (
                      <Card key={key} withBorder p="xs" radius="sm">
                        <Text size="sm" fw={500} mb={4}>
                          {ruleUser?.username || ruleUser?.email || key}
                        </Text>
                        {rules.map((r: any) => (
                          <Group key={r.id} gap="xs" wrap="wrap" mb={2}>
                            <Text
                              size="xs"
                              c="dimmed"
                              style={{ minWidth: 140, overflowWrap: "anywhere", hyphens: "auto" }}
                              lineClamp={1}
                            >
                              {r.fileName}
                            </Text>
                            <Badge size="xs" variant="light" color={
                              r.permission === "DENY" ? "red" :
                              r.permission === "WRITE" ? "green" :
                              r.permission === "ADMIN" ? "blue" : "gray"
                            }>
                              {r.permission}
                            </Badge>
                            {r.canRequestSignature && (
                              <Badge size="xs" variant="dot" color="orange">
                                <TbSignature size={10} /> {t("team.folder.signatureSwitch.short")}
                              </Badge>
                            )}
                            {r.canShareE2E && (
                              <Badge size="xs" variant="dot" color="teal">
                                <TbKey size={10} /> {t("team.folder.e2eShareSwitch.short")}
                              </Badge>
                            )}
                          </Group>
                        ))}
                      </Card>
                    ));
                  })()}
                </Stack>
              </Box>
            )}
          </Box>
        )}

        {/* Modal ajout d'accès */}
        <Modal
          opened={accessModalOpen}
          onClose={() => setAccessModalOpen(false)}
          title={t("team.folder.modal.access.title")}
          centered
        >
          <Stack gap="md">
            <Select
              label={t("team.folder.modal.access.memberLabel")}
              placeholder={t("team.folder.modal.access.memberPlaceholder")}
              value={selectedMemberId}
              onChange={setSelectedMemberId}
              data={
                team?.members
                  ?.filter((m: any) => m.role === "MEMBER")
                  ?.filter((m: any) => !accessRules?.find((r) => r.memberId === m.id))
                  ?.map((m: any) => ({
                    value: m.id,
                    label: m.user?.username || m.user?.email || m.id,
                  })) || []
              }
            />
            <Select
              label={t("team.folder.modal.access.permissionLabel")}
              value={selectedPermission}
              onChange={(v) => setSelectedPermission(v || "READ")}
              data={[
                { value: "NONE", label: t("team.folder.permission.none") },
                { value: "READ", label: t("team.folder.permission.read") },
                { value: "WRITE", label: t("team.folder.permission.write") },
                { value: "ADMIN", label: t("team.folder.permission.adminFull") },
              ]}
            />
            {selectedPermission !== "NONE" && (
              <>
                <Card withBorder p="sm" radius="sm">
                  <Text size="xs" fw={600} mb={4}>{t("team.folder.modal.access.rightsIncluded")}</Text>
                  {selectedPermission === "READ" && (
                    <Text size="xs" c="dimmed">
                      {t("team.folder.modal.access.rights.read")}
                    </Text>
                  )}
                  {selectedPermission === "WRITE" && (
                    <Text size="xs" c="dimmed">
                      {t("team.folder.modal.access.rights.write")}
                    </Text>
                  )}
                  {selectedPermission === "ADMIN" && (
                    <Text size="xs" c="dimmed">
                      {t("team.folder.modal.access.rights.admin")}
                    </Text>
                  )}
                </Card>
                {selectedPermission !== "ADMIN" && (
                  <Card withBorder p="sm" radius="sm" style={{ backgroundColor: accessCanSign ? "var(--mantine-color-orange-light)" : undefined }}>
                    <Switch
                      color="orange"
                      label={
                        <Group gap={6}>
                          <TbSignature size={16} />
                          <Text size="sm" fw={500}>{t("team.folder.signatureSwitch.label")}</Text>
                        </Group>
                      }
                      description={t("team.folder.signatureSwitch.desc")}
                      checked={accessCanSign}
                      onChange={(e) => setAccessCanSign(e.currentTarget.checked)}
                    />
                  </Card>
                )}
                {selectedPermission !== "ADMIN" && (
                  <Card withBorder p="sm" radius="sm" style={{ backgroundColor: accessCanShareE2E ? "var(--mantine-color-teal-light)" : undefined }}>
                    <Switch
                      color="teal"
                      label={
                        <Group gap={6}>
                          <TbKey size={16} />
                          <Text size="sm" fw={500}>{t("team.folder.e2eShareSwitch.label")}</Text>
                        </Group>
                      }
                      description={t("team.folder.e2eShareSwitch.desc")}
                      checked={accessCanShareE2E}
                      onChange={(e) => setAccessCanShareE2E(e.currentTarget.checked)}
                    />
                  </Card>
                )}
              </>
            )}
            <Group justify="flex-end">
              <Button
                variant="default"
                onClick={() => setAccessModalOpen(false)}
              >
                {t("team.folder.modal.cancel")}
              </Button>
              <Button
                leftSection={<TbCheck size={14} />}
                disabled={!selectedMemberId}
                loading={addAccessMutation.isPending}
                onClick={() => {
                  if (selectedMemberId) {
                    addAccessMutation.mutate({
                      memberId: selectedMemberId,
                      permission: selectedPermission,
                      canRequestSignature: selectedPermission === "ADMIN" ? true : accessCanSign,
                      canShareE2E: selectedPermission === "ADMIN" ? true : accessCanShareE2E,
                    });
                  }
                }}
              >
                {t("team.folder.modal.access.addButton")}
              </Button>
            </Group>
          </Stack>
        </Modal>

        {/* Modal de gestion des droits par fichier */}
        <Modal
          opened={filePermsModalOpen}
          onClose={() => setFilePermsModalOpen(false)}
          title={t("team.folder.modal.filePerms.title", { count: selectedFiles.size })}
          size="lg"
        >
          <Stack gap="sm">
            {(() => {
              return (<>
            <Text size="sm" c="dimmed">
              {t("team.folder.modal.filePerms.desc")}
            </Text>
            <Card withBorder p="xs" radius="sm">
              <Text size="xs" c="dimmed" style={{ whiteSpace: "pre-line" }}>
                {t("team.folder.modal.filePerms.legend")}
              </Text>
            </Card>
            {team?.members
              ?.filter((m: any) => m.isActive && m.role === "MEMBER")
              ?.map((m: any) => {
                const hasPerm = filePermMembers[m.id] && filePermMembers[m.id] !== "";
                const isFileAdmin = filePermMembers[m.id] === "ADMIN";
                return (
                  <Card key={m.id} withBorder p="xs" radius="sm">
                    <Group justify="space-between" wrap="nowrap">
                      <Text
                        size="sm"
                        fw={500}
                        style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere", hyphens: "auto" }}
                        lineClamp={1}
                      >
                        {m.user?.email || m.id}
                      </Text>
                      <Select
                        size="sm"
                        w={200}
                        placeholder={t("team.folder.modal.filePerms.noPerm")}
                        clearable
                        value={filePermMembers[m.id] || null}
                        onChange={(val) =>
                          setFilePermMembers((prev) => ({
                            ...prev,
                            [m.id]: val || "",
                          }))
                        }
                        data={[
                          { value: "READ", label: t("team.folder.permission.read") },
                          { value: "WRITE", label: t("team.folder.permission.write") },
                          { value: "ADMIN", label: t("team.folder.permission.admin") },
                          { value: "DENY", label: t("team.folder.permission.none") },
                          { value: "NONE", label: t("team.folder.modal.filePerms.defaultPerm") },
                        ]}
                      />
                    </Group>
                    {hasPerm && !isFileAdmin && filePermMembers[m.id] !== "DENY" && (
                      <Switch
                        mt={6}
                        size="sm"
                        color="orange"
                        label={
                          <Group gap={4}>
                            <TbSignature size={14} />
                            <Text size="xs" fw={500}>{t("team.folder.signatureSwitch.short")}</Text>
                          </Group>
                        }
                        checked={filePermSign[m.id] ?? false}
                        onChange={(e) =>
                          setFilePermSign((prev) => ({
                            ...prev,
                            [m.id]: e.currentTarget.checked,
                          }))
                        }
                      />
                    )}
                    {hasPerm && !isFileAdmin && filePermMembers[m.id] !== "DENY" && (
                      <Switch
                        mt={6}
                        size="sm"
                        color="teal"
                        label={
                          <Group gap={4}>
                            <TbKey size={14} />
                            <Text size="xs" fw={500}>{t("team.folder.e2eShareSwitch.short")}</Text>
                          </Group>
                        }
                        checked={filePermE2E[m.id] ?? false}
                        onChange={(e) =>
                          setFilePermE2E((prev) => ({
                            ...prev,
                            [m.id]: e.currentTarget.checked,
                          }))
                        }
                      />
                    )}
                  </Card>
                );
              })}
              </>);
            })()}
            <Group justify="flex-end" mt="md">
              <Button
                variant="default"
                onClick={() => setFilePermsModalOpen(false)}
              >
                {t("team.folder.modal.cancel")}
              </Button>
              <Button
                color="blue"
                leftSection={<TbShieldCheck size={16} />}
                onClick={submitFilePerms}
                loading={setFileAccessMutation.isPending}
              >
                {t("team.folder.modal.filePerms.applyButton")}
              </Button>
            </Group>
          </Stack>
        </Modal>

        {/* Modal de demande de signature */}
        {sigModalData && (
          <RequestSignatureModal
            opened={!!sigModalData}
            onClose={() => setSigModalData(null)}
            shareId={sigModalData.shareId}
            files={sigModalData.files}
            encryptionKey={teamKeyB64}
            teamId={teamIdStr}
          />
        )}

        {/* Modal E2EE Share */}
        {teamKeyB64 && team?.members && (
          <E2EShareModal
            opened={e2eShareOpen}
            onClose={() => {
              setE2eShareOpen(false);
              setE2eShareFiles([]);
            }}
            teamMembers={team.members}
            files={e2eShareFiles}
            teamKeyB64={teamKeyB64}
            currentUserId={user?.id || ""}
            pqNotificationEncryptionEnabled={
              team.pqNotificationEncryptionEnabled ?? false
            }
          />
        )}
      </Container>
    </>
  );
};

export default TeamFolderPage;
