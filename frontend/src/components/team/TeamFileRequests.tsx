import { useState } from "react";
import { useIntl } from "react-intl";
import useTranslate from "../../hooks/useTranslate.hook";
import { useRouter } from "next/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Modal,
  MultiSelect,
  Select,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { TbFileUpload } from "react-icons/tb";
import useUser from "../../hooks/user.hook";
import useTeamKey from "../../hooks/useTeamKey.hook";
import useFileRequestInfos from "../../hooks/useFileRequestInfos.hook";
import teamService from "../../services/team.service";
import requests from "../../services/teamFileRequest.service";
import { fileRequestFolderLabel } from "../../utils/teamFileRequest.util";
import toast from "../../utils/toast.util";

export default function TeamFileRequests({ teamId }: { teamId?: string }) {
  const { user } = useUser();
  const t = useTranslate();
  const intl = useIntl();
  const router = useRouter();
  const cache = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<string | null>(
    teamId || null,
  );
  const [folderId, setFolderId] = useState<string | null>(null);
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [recipientScope, setRecipientScope] = useState<"ALL" | "SELECTED">(
    "SELECTED",
  );
  const [sendEmail, setSendEmail] = useState(false);
  const [subject, setSubject] = useState("");
  const [note, setNote] = useState("");
  const [deadline, setDeadline] = useState("");
  const [offset, setOffset] = useState(0);
  const [closingId, setClosingId] = useState<string | null>(null);
  const teams = useQuery({
    queryKey: ["teams.list"],
    queryFn: teamService.getMyTeams,
    enabled: !!user && opened,
  });
  const options = useQuery({
    queryKey: ["team.file-request.options", selectedTeam],
    queryFn: () => requests.options(selectedTeam!),
    enabled: opened && !!selectedTeam,
    staleTime: 0,
  });
  const list = useQuery({
    queryKey: ["team.file-requests", teamId, offset],
    queryFn: () => requests.list(teamId!, offset),
    enabled: !!teamId && !!user,
    refetchInterval: 30000,
  });
  // FILE_META_V1: subjects and notes encrypted with K_team.
  const listTeamKey = useTeamKey(
    teamId,
    !!list.data?.requests.some((request) => request.encryptedInfo),
  );
  const infos = useFileRequestInfos(list.data?.requests, listTeamKey);
  const createTeamKey = useTeamKey(
    selectedTeam || undefined,
    opened && !!user?.fileMetaV1TeamWrite,
  );
  const folders = options.data || [];
  const folder = folders.find((f) => f.id === folderId);
  const eligibleIds = new Set(
    folder?.recipients.filter((r) => r.canUpload).map((r) => r.id),
  );
  const validRecipients =
    recipientScope === "ALL"
      ? folder?.recipients.every((r) => r.canUpload)
        ? folder.recipients.map((r) => r.id)
        : []
      : recipientIds.filter((id) => eligibleIds.has(id));
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: ["team.file-requests"] });
    void cache.invalidateQueries({ queryKey: ["team-notifications-list"] });
    void cache.invalidateQueries({ queryKey: ["team-notifications-unread"] });
  };
  const create = useMutation({
    mutationFn: async () => {
      if (
        !selectedTeam ||
        !folderId ||
        !folder ||
        !validRecipients.length ||
        options.isError
      )
        throw new Error("Unavailable destination");
      if (user?.fileMetaV1TeamWrite && !createTeamKey)
        throw new Error("team.fileRequest.error.keys");
      return requests.create(
        selectedTeam,
        {
          folderId,
          subject: subject.trim(),
          note: note.trim() || undefined,
          recipientIds: validRecipients,
          recipientScope,
          sendEmail,
          ...(deadline ? { expiresAt: new Date(deadline).toISOString() } : {}),
        },
        user!.id,
        user!.fileMetaV1TeamWrite ? createTeamKey : null,
      );
    },
    onSuccess: () => {
      const targetTeam = selectedTeam;
      setOpened(false);
      setSendEmail(false);
      setSubject("");
      setNote("");
      setDeadline("");
      setRecipientIds([]);
      setFolderId(null);
      refresh();
      toast.success(t("team.fileRequest.success"));
      if (targetTeam && targetTeam !== teamId)
        void router.push(
          `/team/${encodeURIComponent(targetTeam)}?fileRequests=1`,
        );
    },
    onError: (error: Error) =>
      toast.error(
        error.message === "team.fileRequest.error.keys"
          ? t(error.message)
          : t("team.fileRequest.error.create"),
      ),
  });
  const close = useMutation({
    mutationFn: (id: string) => requests.close(teamId!, id),
    onSuccess: () => {
      setClosingId(null);
      refresh();
    },
    onError: () => toast.error(t("team.fileRequest.error.close")),
  });

  return (
    <>
      <Group justify="space-between" my="md">
        {teamId && <Title order={3}>{t("team.fileRequest.title")}</Title>}
        <Button
          variant="light"
          leftSection={<TbFileUpload size={18} />}
          onClick={() => {
            setSelectedTeam(teamId || null);
            setFolderId(null);
            setRecipientIds([]);
            setOpened(true);
          }}
        >
          {t("team.fileRequest.create")}
        </Button>
      </Group>
      {teamId && (
        <Stack mb="lg">
          {list.isLoading && <Loader size="sm" />}
          {list.isError && (
            <Alert color="red">
              {t("team.fileRequest.error.list")}{" "}
              <Button variant="subtle" onClick={() => void list.refetch()}>
                {t("team.fileRequest.retry")}
              </Button>
            </Alert>
          )}
          {list.data?.requests.length === 0 && (
            <Text size="sm" c="dimmed">
              {t("team.fileRequest.empty")}
            </Text>
          )}
          {list.data?.requests.map((request) => (
            <Card key={request.id} withBorder padding="md">
              <Group justify="space-between">
                <Text fw={600}>
                  {infos[request.id]?.subject ||
                    t("team.fileRequest.encryptedSubject")}
                </Text>
                <Badge color={request.status === "OPEN" ? "blue" : "gray"}>
                  {request.status === "OPEN"
                    ? t("team.fileRequest.status.open")
                    : request.status === "EXPIRED"
                      ? t("team.fileRequest.status.expired")
                      : t("team.fileRequest.status.closed")}
                </Badge>
              </Group>
              <Text size="sm" c="dimmed">
                {t("team.fileRequest.details", {
                  sender:
                    request.creatorId === user?.id
                      ? t("team.fileRequest.sent")
                      : t("team.fileRequest.from", {
                          name:
                            request.creator.username || request.creator.email,
                        }),
                  folder:
                    request.folder?.name || t("team.fileRequest.deletedFolder"),
                  date:
                    intl.formatDate(request.expiresAt) +
                    " " +
                    intl.formatTime(request.expiresAt, {
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                })}
              </Text>
              {infos[request.id]?.note && (
                <Text
                  size="sm"
                  mt="sm"
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {infos[request.id]?.note}
                </Text>
              )}
              <Group gap="xs" mt="sm">
                {request.recipients.map((r) => (
                  <Badge
                    key={r.user.id}
                    variant="light"
                    color={r.fileCount ? "teal" : "gray"}
                  >
                    {t("team.fileRequest.files", {
                      name: r.user.username || r.user.email,
                      count: r.fileCount,
                    })}
                  </Badge>
                ))}
              </Group>
              <Group mt="sm">
                {request.canRespond && (
                  <Button
                    size="xs"
                    onClick={() =>
                      void router.push(
                        `/upload?${new URLSearchParams({ teamFolderId: request.folderId!, teamFileRequestId: request.id, teamId: request.teamId })}`,
                      )
                    }
                  >
                    {t("team.fileRequest.upload")}
                  </Button>
                )}
                {request.canWrite && request.folderId && (
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() =>
                      void router.push(
                        `/team/${encodeURIComponent(request.teamId)}/folder/${encodeURIComponent(request.folderId!)}`,
                      )
                    }
                  >
                    {t("team.fileRequest.openFolder")}
                  </Button>
                )}
                {request.creatorId === user?.id &&
                  request.status === "OPEN" && (
                    <Button
                      size="xs"
                      color="red"
                      variant="subtle"
                      onClick={() => setClosingId(request.id)}
                    >
                      {t("team.fileRequest.close")}
                    </Button>
                  )}
                {!request.canRespond &&
                  request.status === "OPEN" &&
                  request.creatorId !== user?.id && (
                    <Text size="xs" c="dimmed">
                      {t("team.fileRequest.error.upload")}
                    </Text>
                  )}
              </Group>
            </Card>
          ))}
          {!!list.data?.total && list.data.total > 25 && (
            <Group>
              <Button
                variant="subtle"
                disabled={!offset}
                onClick={() => setOffset((n) => Math.max(0, n - 25))}
              >
                {t("team.fileRequest.previous")}
              </Button>
              <Text size="sm">
                {t("team.fileRequest.range", {
                  start: offset + 1,
                  end: Math.min(offset + 25, list.data.total),
                  total: list.data.total,
                })}
              </Text>
              <Button
                variant="subtle"
                disabled={offset + 25 >= list.data.total}
                onClick={() => setOffset((n) => n + 25)}
              >
                {t("team.fileRequest.next")}
              </Button>
            </Group>
          )}
        </Stack>
      )}
      <Modal
        opened={opened}
        onClose={() => !create.isPending && setOpened(false)}
        title={t("team.fileRequest.create")}
        size="lg"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!create.isPending) create.mutate();
          }}
        >
          <Stack>
            {teams.isError && (
              <Alert color="red">{t("team.fileRequest.error.teams")}</Alert>
            )}
            <Select
              label={t("team.fileRequest.team")}
              required
              searchable
              data={(teams.data || []).map((t) => ({
                value: t.id,
                label: t.name,
              }))}
              value={selectedTeam}
              disabled={create.isPending || teams.isLoading}
              onChange={(value) => {
                setSelectedTeam(value);
                setFolderId(null);
                setRecipientIds([]);
              }}
            />
            <TextInput
              label={t("team.fileRequest.subject")}
              placeholder={t("team.fileRequest.subject.placeholder")}
              required
              minLength={3}
              maxLength={120}
              value={subject}
              onChange={(e) => setSubject(e.currentTarget.value)}
            />
            {options.isError && (
              <Alert color="red">
                {t("team.fileRequest.error.destinations")}{" "}
                <Button variant="subtle" onClick={() => void options.refetch()}>
                  {t("team.fileRequest.retry")}
                </Button>
              </Alert>
            )}
            <Select
              label={t("team.fileRequest.destination")}
              required
              searchable
              value={folderId}
              disabled={
                !selectedTeam ||
                options.isFetching ||
                options.isError ||
                create.isPending
              }
              data={folders.map((f) => ({
                value: f.id,
                label: fileRequestFolderLabel(f, folders),
              }))}
              onChange={(value) => {
                setFolderId(value);
                setRecipientIds([]);
              }}
            />
            {selectedTeam && options.isSuccess && !folders.length && (
              <Alert color="yellow">{t("team.fileRequest.noFolders")}</Alert>
            )}
            <Text size="xs" c="dimmed">
              {t("team.fileRequest.rights.hint")}
            </Text>
            <SegmentedControl
              value={recipientScope}
              onChange={(value) => {
                setRecipientScope(value as "ALL" | "SELECTED");
                setRecipientIds([]);
              }}
              data={[
                {
                  value: "SELECTED",
                  label: t("team.fileRequest.scope.selected"),
                },
                { value: "ALL", label: t("team.fileRequest.scope.all") },
              ]}
              disabled={create.isPending}
            />
            {recipientScope === "ALL" &&
              folder &&
              !folder.recipients.every((r) => r.canUpload) && (
                <Alert color="yellow">{t("team.fileRequest.allRights")}</Alert>
              )}
            {recipientScope === "SELECTED" && (
              <MultiSelect
                label={t("team.fileRequest.recipients")}
                required
                searchable
                value={validRecipients}
                disabled={!folder || create.isPending}
                data={(folder?.recipients || []).map((r) => ({
                  value: r.id,
                  label: `${r.username || r.email} (${r.email})`,
                  disabled: !r.canUpload,
                }))}
                onChange={setRecipientIds}
              />
            )}
            {folder && !folder.recipients.length && (
              <Alert color="yellow">{t("team.fileRequest.noRecipients")}</Alert>
            )}
            <Text size="xs" c="dimmed">
              {t("team.fileRequest.notifications.hint")}
            </Text>
            <Checkbox
              label={t("team.fileRequest.email")}
              checked={sendEmail}
              onChange={(e) => setSendEmail(e.currentTarget.checked)}
              disabled={create.isPending}
            />
            {sendEmail && (
              <Text size="xs" c="dimmed">
                {t("team.fileRequest.email.hint")}
              </Text>
            )}
            <Textarea
              label={t("team.fileRequest.note")}
              placeholder={t("team.fileRequest.note.placeholder")}
              maxLength={2000}
              autosize
              minRows={3}
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
            />
            <Text size="xs" c="dimmed">
              {t(
                user?.fileMetaV1TeamWrite && createTeamKey
                  ? "team.fileRequest.metadata.encryptedHint"
                  : "team.fileRequest.metadata.hint",
              )}
            </Text>
            <TextInput
              type="datetime-local"
              label={t("team.fileRequest.deadline")}
              description={t("team.fileRequest.deadline.hint")}
              value={deadline}
              onChange={(e) => setDeadline(e.currentTarget.value)}
            />
            <Group justify="flex-end">
              <Button
                variant="subtle"
                disabled={create.isPending}
                onClick={() => setOpened(false)}
              >
                {t("team.fileRequest.cancel")}
              </Button>
              <Button
                type="submit"
                loading={create.isPending}
                disabled={
                  !selectedTeam ||
                  !folder ||
                  !validRecipients.length ||
                  subject.trim().length < 3 ||
                  options.isFetching ||
                  options.isError
                }
              >
                {t("team.fileRequest.submit")}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
      <Modal
        opened={!!closingId}
        onClose={() => !close.isPending && setClosingId(null)}
        title={t("team.fileRequest.close.title")}
      >
        <Stack>
          <Text>{t("team.fileRequest.close.hint")}</Text>
          <Group justify="flex-end">
            <Button
              variant="subtle"
              onClick={() => setClosingId(null)}
              disabled={close.isPending}
            >
              {t("team.fileRequest.cancel")}
            </Button>
            <Button
              color="red"
              loading={close.isPending}
              onClick={() => closingId && close.mutate(closingId)}
            >
              {t("team.fileRequest.close")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
