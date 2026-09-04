import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { TbKey, TbLock, TbLockOff, TbShieldCheck } from "react-icons/tb";
import useTranslate from "../../hooks/useTranslate.hook";
import useUser from "../../hooks/user.hook";
import toast from "../../utils/toast.util";
import {
  batchGetPublicKeys,
  grantFileAccessToTeam,
  type BulkGrantResult,
} from "../../services/crypto.service";

interface TeamMember {
  id: string;
  userId: string;
  user?: { id: string; username?: string; email?: string };
  role: string;
  isActive: boolean;
}

interface FileTarget {
  fileId: string;
  teamFileId?: string;
  shareId: string;
  name: string;
  uploadedByUserId?: string;
}

interface E2EShareModalProps {
  opened: boolean;
  onClose: () => void;
  teamMembers: TeamMember[];
  files: FileTarget[];
  teamKeyB64: string;
  currentUserId: string;
  pqNotificationEncryptionEnabled: boolean;
}

/**
 * Decode a base64url string to Uint8Array (DEK raw bytes).
 */
function base64UrlToUint8Array(b64url: string): Uint8Array {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const E2EShareModal = ({
  opened,
  onClose,
  teamMembers,
  files,
  teamKeyB64,
  currentUserId,
  pqNotificationEncryptionEnabled,
}: E2EShareModalProps) => {
  const t = useTranslate();
  const { user } = useUser();
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(
    new Set(),
  );

  // Fetch E2EE public keys for all team members to show availability
  const eligibleMembers = teamMembers.filter(
    (m) => m.isActive && m.user?.id && m.user.id !== currentUserId,
  );
  const userIds = eligibleMembers.map((m) => m.user!.id);

  // Determine uploaders: a member is "uploader" if they uploaded ALL selected files
  // (i.e., you cannot share a file with the person who uploaded it)
  const uploaderUserIds = new Set(
    files.map((f) => f.uploadedByUserId).filter(Boolean) as string[],
  );

  const { data: publicKeysMap, isLoading: keysLoading } = useQuery({
    queryKey: ["e2ee.publicKeys.batch", ...userIds],
    queryFn: () => batchGetPublicKeys(userIds),
    enabled: opened && userIds.length > 0,
    staleTime: 30_000,
  });

  // Map userId -> has E2EE keys
  const keyStatus = new Map<string, boolean>();
  if (publicKeysMap) {
    for (const entry of publicKeysMap) {
      keyStatus.set(entry.userId, !!entry.x25519);
    }
  }

  const grantMutation = useMutation({
    mutationFn: async (): Promise<{
      totalFiles: number;
      totalSuccess: number;
      totalFailed: number;
    }> => {
      // Convert team key to raw DEK bytes
      const dekRaw = base64UrlToUint8Array(teamKeyB64);

      const members = eligibleMembers
        .filter((m) => selectedMembers.has(m.user!.id))
        .map((m) => ({ userId: m.user!.id }));

      let totalSuccess = 0;
      let totalFailed = 0;

      // Create grants for each file
      for (const file of files) {
        // Backend requires EXACTLY one of fileId, teamFileId, shareId
        const target: { fileId?: string; teamFileId?: string; shareId?: string } = {};
        if (file.teamFileId) target.teamFileId = file.teamFileId;
        else target.fileId = file.fileId;

        // E2E-encrypted notification metadata. ML-KEM is used only when the
        // Team administrator explicitly enabled the hybrid notification mode.
        const notifMeta = {
          senderName: user?.username || user?.email || "Un membre",
          fileName: file.name,
          highlightFileId: file.teamFileId || file.fileId,
        };

        const result: BulkGrantResult = await grantFileAccessToTeam(
          dekRaw,
          members,
          target,
          notifMeta,
          pqNotificationEncryptionEnabled,
        );
        totalSuccess += result.success;
        totalFailed += result.failed;
      }

      return { totalFiles: files.length, totalSuccess, totalFailed };
    },
    onSuccess: (result) => {
      if (result.totalFailed === 0) {
        toast.success(
          t("team.e2e.share.success", {
            files: result.totalFiles,
            grants: result.totalSuccess,
          }),
        );
      } else {
        toast.info(
          t("team.e2e.share.partial", {
            success: result.totalSuccess,
            failed: result.totalFailed,
          }),
        );
      }
      setSelectedMembers(new Set());
      onClose();
    },
    onError: (err: any) => {
      toast.error(
        err?.message || t("team.e2e.share.error"),
      );
    },
  });

  const toggleMember = (userId: string) => {
    setSelectedMembers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const selectAllEligible = () => {
    const eligible = eligibleMembers
      .filter((m) => {
        const userId = m.user!.id;
        const hasKey = keyStatus.get(userId);
        const isUploader = uploaderUserIds.has(userId) &&
          files.every((f) => f.uploadedByUserId === userId);
        return hasKey && !isUploader;
      })
      .map((m) => m.user!.id);
    setSelectedMembers(new Set(eligible));
  };

  const hasAnyKeyHolder = eligibleMembers.some((m) =>
    keyStatus.get(m.user!.id),
  );

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <TbKey size={20} />
          <Text fw={600}>
            {t("team.e2e.share.title", { count: files.length })}
          </Text>
        </Group>
      }
      size="md"
      centered
    >
      <Stack gap="md">
        <Card withBorder p="sm" radius="sm" bg="var(--mantine-color-blue-light)">
          <Text size="xs" c="dimmed">
            {t("team.e2e.share.desc")}
          </Text>
        </Card>

        {/* File list summary */}
        <Card withBorder p="xs" radius="sm">
          <Text size="xs" fw={600} mb={4}>
            {t("team.e2e.share.filesLabel")}
          </Text>
          {files.slice(0, 5).map((f) => (
            <Text key={f.fileId} size="xs" c="dimmed" lineClamp={1}>
              • {f.name}
            </Text>
          ))}
          {files.length > 5 && (
            <Text size="xs" c="dimmed" fs="italic">
              +{files.length - 5} {t("team.e2e.share.moreFiles")}
            </Text>
          )}
        </Card>

        {/* Member selection */}
        <Group justify="space-between" align="center">
          <Text size="sm" fw={600}>
            {t("team.e2e.share.recipientsLabel")}
          </Text>
          {hasAnyKeyHolder && (
            <Button
              size="xs"
              variant="subtle"
              onClick={selectAllEligible}
            >
              {t("team.e2e.share.selectAll")}
            </Button>
          )}
        </Group>

        {keysLoading ? (
          <Group justify="center" py="md">
            <Loader size="sm" />
          </Group>
        ) : eligibleMembers.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center">
            {t("team.e2e.share.noMembers")}
          </Text>
        ) : (
          <Stack gap="xs">
            {eligibleMembers.map((member) => {
              const userId = member.user!.id;
              const hasKey = keyStatus.get(userId) ?? false;
              const isUploader = uploaderUserIds.has(userId) &&
                files.every((f) => f.uploadedByUserId === userId);
              const canSelect = hasKey && !isUploader;
              const isSelected = selectedMembers.has(userId);

              return (
                <Card
                  key={member.id}
                  withBorder
                  p="xs"
                  radius="sm"
                  style={{
                    opacity: canSelect ? 1 : 0.5,
                    cursor: canSelect ? "pointer" : "not-allowed",
                  }}
                  onClick={() => canSelect && toggleMember(userId)}
                >
                  <Group justify="space-between" wrap="nowrap">
                    <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                      <Checkbox
                        size="sm"
                        checked={isSelected}
                        disabled={!canSelect}
                        onChange={() => canSelect && toggleMember(userId)}
                      />
                      <Text size="sm" fw={500} lineClamp={1}>
                        {member.user?.username || member.user?.email || userId}
                      </Text>
                      {member.user?.email && member.user.username && (
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {member.user.email}
                        </Text>
                      )}
                    </Group>
                    <Group gap="xs" wrap="nowrap">
                      {isUploader && (
                        <Badge size="xs" variant="light" color="yellow">
                          {t("team.e2e.share.uploader")}
                        </Badge>
                      )}
                      <Badge
                        size="xs"
                        variant="light"
                        color={
                          member.role === "OWNER"
                            ? "violet"
                            : member.role === "ADMIN"
                              ? "blue"
                              : "gray"
                        }
                      >
                        {member.role}
                      </Badge>
                      {hasKey ? (
                        <ThemeIcon
                          size={20}
                          radius="xl"
                          variant="light"
                          color="green"
                        >
                          <TbShieldCheck size={12} />
                        </ThemeIcon>
                      ) : (
                        <ThemeIcon
                          size={20}
                          radius="xl"
                          variant="light"
                          color="gray"
                        >
                          <TbLockOff size={12} />
                        </ThemeIcon>
                      )}
                    </Group>
                  </Group>
                </Card>
              );
            })}
          </Stack>
        )}

        {/* Legend */}
        <Group gap="lg">
          <Group gap={4}>
            <ThemeIcon size={16} radius="xl" variant="light" color="green">
              <TbShieldCheck size={10} />
            </ThemeIcon>
            <Text size="xs" c="dimmed">
              {t("team.e2e.share.legend.hasKeys")}
            </Text>
          </Group>
          <Group gap={4}>
            <ThemeIcon size={16} radius="xl" variant="light" color="gray">
              <TbLockOff size={10} />
            </ThemeIcon>
            <Text size="xs" c="dimmed">
              {t("team.e2e.share.legend.noKeys")}
            </Text>
          </Group>
        </Group>

        {/* Actions */}
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>
            {t("team.e2e.share.cancel")}
          </Button>
          <Button
            leftSection={<TbLock size={16} />}
            disabled={selectedMembers.size === 0}
            loading={grantMutation.isPending}
            onClick={() => { setTimeout(() => grantMutation.mutate(), 0); }}
          >
            {t("team.e2e.share.submit", { count: selectedMembers.size })}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};

export default E2EShareModal;
