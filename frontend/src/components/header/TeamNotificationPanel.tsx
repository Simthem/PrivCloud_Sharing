import {
  ActionIcon,
  Badge,
  Box,
  Group,
  Indicator,
  Loader,
  Popover,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  TbBell,
  TbBellRinging,
  TbCheck,
  TbChecks,
  TbFile,
  TbFolder,
  TbKey,
  TbLock,
  TbShare,
  TbTrash,
  TbUserMinus,
  TbUserPlus,
} from "react-icons/tb";
import {
  getTeamNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  deleteAllNotifications,
  TeamNotification,
} from "../../services/teamNotification.service";
import { decryptNotificationMetadata } from "../../services/crypto.service";
import { getUserKey, importKeyFromBase64 } from "../../utils/crypto.util";
import { useStyles } from "./Header.styles";

const NOTIFICATION_ICONS: Record<string, React.ReactNode> = {
  FILE_SHARED: <TbShare size={16} />,
  FILE_UPLOADED: <TbFile size={16} />,
  FILE_DELETED: <TbTrash size={16} />,
  GRANT_RECEIVED: <TbKey size={16} />,
  GRANT_REVOKED: <TbKey size={16} />,
  KEY_ROTATED: <TbKey size={16} />,
  MEMBER_JOINED: <TbUserPlus size={16} />,
  MEMBER_LEFT: <TbUserMinus size={16} />,
};

const NOTIFICATION_POLL_INTERVAL_MS = 30_000;

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "À l'instant";
  if (minutes < 60) return `Il y a ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Il y a ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `Il y a ${days}j`;
  return new Date(dateStr).toLocaleDateString("fr-FR");
}

const TeamNotificationPanel = () => {
  const { classes, cx } = useStyles();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [opened, setOpened] = useState(false);

  // Decrypted metadata cache: notificationId -> decrypted metadata object
  const [decryptedCache, setDecryptedCache] = useState<
    Map<string, Record<string, unknown>>
  >(new Map());
  const decryptingRef = useRef<Set<string>>(new Set());

  // Decrypt notifications with encryptedMetadata when they appear
  const decryptNotifications = useCallback(
    async (notifications: TeamNotification[]) => {
      const userKeyB64 = getUserKey();
      if (!userKeyB64) return;

      const toDecrypt = notifications.filter(
        (n) =>
          n.encryptedMetadata &&
          !decryptedCache.has(n.id) &&
          !decryptingRef.current.has(n.id),
      );

      if (toDecrypt.length === 0) return;

      const masterKey = await importKeyFromBase64(userKeyB64);
      const newEntries = new Map<string, Record<string, unknown>>();

      for (const notif of toDecrypt) {
        decryptingRef.current.add(notif.id);
        try {
          const meta = await decryptNotificationMetadata(
            notif.encryptedMetadata!,
            masterKey,
          );
          if (meta) newEntries.set(notif.id, meta);
        } catch {
          // Decryption failed - will show generic info
        }
        decryptingRef.current.delete(notif.id);
      }

      if (newEntries.size > 0) {
        setDecryptedCache((prev) => {
          const next = new Map(prev);
          newEntries.forEach((v, k) => next.set(k, v));
          return next;
        });
      }
    },
    [decryptedCache],
  );

  // Keep polling explicit and bounded; Web Push remains the instant channel.
  const { data: unreadData } = useQuery({
    queryKey: ["team-notifications-unread"],
    queryFn: ({ signal }) => getUnreadNotificationCount(undefined, signal),
    refetchInterval: NOTIFICATION_POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    staleTime: 5000,
    retry: false,
  });

  // Fetch notifications list when panel is opened and keep it live while open.
  const { data: notifData, isLoading } = useQuery({
    queryKey: ["team-notifications-list"],
    queryFn: ({ signal }) => getTeamNotifications({ limit: 30, signal }),
    enabled: opened,
    refetchInterval: opened ? NOTIFICATION_POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: true,
    staleTime: 5000,
    retry: false,
  });

  // Mark as read mutation
  const markReadMutation = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-notifications-unread"] });
      queryClient.invalidateQueries({ queryKey: ["team-notifications-list"] });
    },
  });

  // Mark all as read mutation
  const markAllReadMutation = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-notifications-unread"] });
      queryClient.invalidateQueries({ queryKey: ["team-notifications-list"] });
    },
  });

  // Delete all notifications mutation
  const deleteAllMutation = useMutation({
    mutationFn: () => deleteAllNotifications(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-notifications-unread"] });
      queryClient.invalidateQueries({ queryKey: ["team-notifications-list"] });
    },
  });

  const unreadCount = unreadData?.count || 0;
  const notifications = useMemo(() => notifData?.notifications || [], [notifData]);

  // Trigger decryption when notifications load
  useEffect(() => {
    if (notifications.length > 0) {
      decryptNotifications(notifications);
    }
  }, [notifications, decryptNotifications]);

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      offset={8}
      width={380}
      shadow="lg"
      withArrow
    >
      <Popover.Target>
        <Tooltip label="Notifications équipe" withArrow>
          <UnstyledButton
            className={cx(classes.link, classes.withIcon)}
            onClick={() => setOpened((o) => !o)}
            aria-label="Team notifications"
          >
            <Indicator
              color="red"
              size={unreadCount > 0 ? 16 : 0}
              label={unreadCount > 99 ? "99+" : unreadCount}
              offset={2}
              disabled={unreadCount === 0}
            >
              {unreadCount > 0 ? <TbBellRinging size={18} /> : <TbBell size={18} />}
            </Indicator>
          </UnstyledButton>
        </Tooltip>
      </Popover.Target>

      <Popover.Dropdown p={0}>
        {/* Fixed header: Push notification toggle */}
        <Box
          p="sm"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 10,
            backgroundColor: "var(--mantine-color-body)",
            borderBottom: "1px solid var(--mantine-color-default-border)",
          }}
        >
          <Group justify="space-between" align="center">
            <Text fw={600} size="sm">
              Notifications
            </Text>
            <Group gap="xs">
              {unreadCount > 0 && (
                <Tooltip label="Tout marquer comme lu">
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    onClick={() => markAllReadMutation.mutate()}
                    loading={markAllReadMutation.isPending}
                  >
                    <TbChecks size={16} />
                  </ActionIcon>
                </Tooltip>
              )}
              {notifications.length > 0 && (
                <Tooltip label="Vider la liste">
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    onClick={() => deleteAllMutation.mutate()}
                    loading={deleteAllMutation.isPending}
                  >
                    <TbTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          </Group>
        </Box>

        {/* Scrollable notification list */}
        <ScrollArea.Autosize mah={400}>
          {isLoading ? (
            <Box p="lg" ta="center">
              <Loader size="sm" />
            </Box>
          ) : notifications.length === 0 ? (
            <Box p="lg" ta="center">
              <Text size="sm" c="dimmed">
                Aucune notification
              </Text>
            </Box>
          ) : (
            <Stack gap={0}>
              {notifications.map((notif) => (
                <NotificationItem
                  key={notif.id}
                  notification={notif}
                  decryptedMeta={decryptedCache.get(notif.id)}
                  onMarkRead={(id) => markReadMutation.mutate(id)}
                  onNavigate={(path) => {
                    setOpened(false);
                    router.push(path);
                  }}
                />
              ))}
            </Stack>
          )}
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
};

// ============================================================
// Individual notification item
// ============================================================

const NotificationItem = ({
  notification,
  decryptedMeta,
  onMarkRead,
  onNavigate,
}: {
  notification: TeamNotification;
  decryptedMeta?: Record<string, unknown>;
  onMarkRead: (_id: string) => void;
  onNavigate: (_path: string) => void;
}) => {
  const icon = NOTIFICATION_ICONS[notification.type] || <TbBell size={16} />;
  const isEncrypted = !!notification.encryptedMetadata;
  const isDecrypted = !!decryptedMeta;

  // Resolved title: use decrypted metadata if available for encrypted notifications
  const displayTitle = (() => {
    if (isEncrypted && isDecrypted) {
      const sender = decryptedMeta.senderName as string || "Un membre";
      const fileName = decryptedMeta.fileName as string || "un fichier";
      return `${sender} a partagé "${fileName}"`;
    }
    return notification.title;
  })();

  // Build navigation path: prefer folder with file highlight, fallback to team page
  const getNavigationPath = (): string | null => {
    if (notification.team && notification.folder) {
      const base = `/team/${notification.team.id}/folder/${notification.folder.id}`;
      // Try teamFile.id first, then decrypted metadata, then plaintext metadata
      if (notification.teamFile) {
        return `${base}?highlight=${notification.teamFile.id}`;
      }
      // Decrypted metadata takes priority
      if (decryptedMeta?.highlightFileId) {
        return `${base}?highlight=${decryptedMeta.highlightFileId}`;
      }
      // Fallback to plaintext metadata
      if (notification.metadata) {
        try {
          const meta = JSON.parse(notification.metadata);
          if (meta.highlightFileId) {
            return `${base}?highlight=${meta.highlightFileId}`;
          }
        } catch { /* ignore malformed metadata */ }
      }
      return base;
    }
    if (notification.team) {
      return `/team/${notification.team.id}`;
    }
    return null;
  };

  const navPath = getNavigationPath();

  return (
    <UnstyledButton
      py="xs"
      px={0}
      style={{
        display: "block",
        width: "100%",
        backgroundColor: notification.isRead
          ? "transparent"
          : "var(--mantine-color-blue-light)",
        borderBottom: "1px solid var(--mantine-color-default-border)",
        transition: "background-color 150ms ease",
        cursor: navPath ? "pointer" : "default",
      }}
      onClick={() => {
        if (!notification.isRead) onMarkRead(notification.id);
        if (navPath) onNavigate(navPath);
      }}
    >
      <Group gap="sm" align="flex-start" wrap="nowrap" px="sm">
        <Box mt={2} c={notification.isRead ? "dimmed" : "blue"}>
          {icon}
        </Box>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" fw={notification.isRead ? 400 : 600} lineClamp={2}>
            {displayTitle}
          </Text>
          <Group gap="xs" mt={2}>
            {isEncrypted && (
              <Badge
                size="xs"
                variant="light"
                color={isDecrypted ? "teal" : "orange"}
                leftSection={<TbLock size={10} />}
              >
                {isDecrypted ? "E2E" : "Chiffré"}
              </Badge>
            )}
            {notification.team && (
              <Badge size="xs" variant="light" color="gray">
                {notification.team.name}
              </Badge>
            )}
            {notification.folder && (
              <Badge size="xs" variant="light" color="cyan" leftSection={<TbFolder size={10} />}>
                {notification.folder.name}
              </Badge>
            )}
            {notification.teamFile && (
              <Badge size="xs" variant="light" color="violet" leftSection={<TbFile size={10} />}>
                {notification.teamFile.name}
              </Badge>
            )}
            {!notification.teamFile && isDecrypted && typeof decryptedMeta.fileName === "string" && (
              <Badge size="xs" variant="light" color="violet" leftSection={<TbFile size={10} />}>
                {decryptedMeta.fileName}
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed" mt={2}>
            {formatTimeAgo(notification.createdAt)}
          </Text>
        </Box>
        {!notification.isRead && (
          <Tooltip label="Marquer comme lu">
            <ActionIcon
              variant="subtle"
              size="xs"
              color="blue"
              onClick={(e) => {
                e.stopPropagation();
                onMarkRead(notification.id);
              }}
            >
              <TbCheck size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </UnstyledButton>
  );
};

export default TeamNotificationPanel;
