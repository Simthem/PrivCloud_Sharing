import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useEffect, useRef, useState } from "react";
import {
  TbCalendarPlus,
  TbCopy,
  TbEyeCheck,
  TbTrash,
  TbUserX,
} from "react-icons/tb";
import useTranslate from "../../../hooks/useTranslate.hook";
import teamExternalService, {
  type ExternalSeat,
  type ExternalSeatList,
  type RevocationReminderMode,
} from "../../../services/teamExternal.service";
import { copyToClipboard } from "../../../utils/clipboard.util";
import toast from "../../../utils/toast.util";

const STATUS_COLORS: Record<ExternalSeat["status"], string> = {
  PENDING: "yellow",
  ACTIVE: "teal",
  REVOKED: "gray",
  EXPIRED: "gray",
};

// Native date inputs speak local YYYY-MM-DD: the access ends that evening.
const endOfDay = (value: string) =>
  dayjs(value).endOf("day").subtract(1, "minute").toISOString();
const dateInput = (date: dayjs.Dayjs) => date.format("YYYY-MM-DD");

export default function ExternalSeatsPanel({ teamId }: { teamId: string }) {
  const t = useTranslate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [endDate, setEndDate] = useState(dateInput(dayjs().add(30, "day")));
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [extending, setExtending] = useState<Record<string, string>>({});

  // Reached from the invite form through /team/{id}/settings#external-contractors.
  const section = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);

  const seatsKey = ["team-external-seats", teamId];
  const previewsKey = ["team-external-previews", teamId];
  const { data } = useQuery({
    queryKey: seatsKey,
    queryFn: () => teamExternalService.listSeats(teamId),
    enabled: !!teamId,
  });
  const { data: previews } = useQuery({
    queryKey: previewsKey,
    queryFn: () => teamExternalService.listPreviews(teamId),
    enabled: !!teamId,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: seatsKey });
    void queryClient.invalidateQueries({ queryKey: previewsKey });
  };

  const invite = useMutation({
    mutationFn: () =>
      teamExternalService.inviteSeat(teamId, {
        email: email.trim(),
        displayName: displayName.trim() || undefined,
        accessExpiresAt: endOfDay(endDate),
      }),
    onSuccess: (result) => {
      setInviteUrl(result.inviteUrl);
      setEmail("");
      setDisplayName("");
      refresh();
    },
    onError: toast.axiosError,
  });

  const extend = useMutation({
    mutationFn: ({ seatId, date }: { seatId: string; date: string }) =>
      teamExternalService.updateSeat(teamId, seatId, endOfDay(date)),
    onSuccess: (_, { seatId }) => {
      setExtending((current) => {
        const next = { ...current };
        delete next[seatId];
        return next;
      });
      toast.success(t("team.external.seats.extended"));
      refresh();
    },
    onError: toast.axiosError,
  });

  const revoke = useMutation({
    mutationFn: (seatId: string) =>
      teamExternalService.revokeSeat(teamId, seatId),
    onSuccess: refresh,
    onError: toast.axiosError,
  });

  const reminder = useMutation({
    mutationFn: ({
      seatId,
      mode,
    }: {
      seatId: string;
      mode: RevocationReminderMode;
    }) => teamExternalService.setRevocationReminder(teamId, seatId, mode),
    onMutate: async ({ seatId, mode }) => {
      await queryClient.cancelQueries({ queryKey: seatsKey });
      const previous = queryClient.getQueryData<ExternalSeatList>(seatsKey);
      queryClient.setQueryData<ExternalSeatList>(seatsKey, (current) =>
        current
          ? {
              ...current,
              seats: current.seats.map((seat) =>
                seat.id === seatId ? { ...seat, reminderMode: mode } : seat,
              ),
            }
          : current,
      );
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous)
        queryClient.setQueryData(seatsKey, context.previous);
      toast.axiosError(error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: seatsKey }),
  });

  const removePreview = useMutation({
    mutationFn: (previewId: string) =>
      teamExternalService.deletePreview(teamId, previewId),
    onSuccess: refresh,
    onError: toast.axiosError,
  });

  useEffect(() => {
    if (!data || scrolled.current) return;
    if (window.location.hash !== "#external-contractors") return;
    scrolled.current = true;
    section.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [data]);

  const minDate = dateInput(dayjs().add(1, "day"));
  const maxDate = dateInput(dayjs().add(89, "day"));
  const full = !!data && data.limit > 0 && data.used >= data.limit;
  const seats = data?.seats ?? [];

  return (
    <Paper
      withBorder
      p="lg"
      mb="lg"
      id="external-contractors"
      ref={section}
      style={{ scrollMarginTop: 80 }}
    >
      <Group mb="md">
        <TbEyeCheck size={20} />
        <Title order={4}>{t("team.external.seats.title")}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="xs">
        {t("team.external.seats.hint")}
      </Text>
      <Text size="sm" c="dimmed" mb="md">
        {t(
          data?.limit
            ? "team.external.seats.usage"
            : "team.external.seats.usageUnlimited",
          {
            used: data?.used ?? 0,
            limit: data?.limit ?? 0,
          },
        )}
      </Text>

      <Stack gap="sm" mb="md">
        {seats.map((seat) => {
          const seatPreviews = (previews ?? []).filter(
            (preview) =>
              preview.seatId === seat.id && preview.status === "READY",
          );
          const open = seat.status === "ACTIVE" || seat.status === "PENDING";
          return (
            <Paper key={seat.id} withBorder p="sm">
              <Group justify="space-between" wrap="wrap" gap="xs">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
                    {seat.displayName || seat.email}
                  </Text>
                  {seat.displayName && (
                    <Text
                      size="xs"
                      c="dimmed"
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {seat.email}
                    </Text>
                  )}
                  <Text size="xs" c="dimmed">
                    {t("team.external.seats.accessEnds", {
                      date: dayjs(seat.accessExpiresAt).format("LL"),
                    })}
                  </Text>
                </Stack>
                <Group gap={6}>
                  <Badge color={STATUS_COLORS[seat.status]} variant="light">
                    {t(
                      `team.external.seats.status.${seat.status.toLowerCase()}`,
                    )}
                  </Badge>
                  {open && (
                    <Tooltip label={t("team.external.seats.extend")}>
                      <ActionIcon
                        variant="light"
                        aria-label={t("team.external.seats.extend")}
                        onClick={() =>
                          setExtending((current) => ({
                            ...current,
                            [seat.id]: dateInput(dayjs(seat.accessExpiresAt)),
                          }))
                        }
                      >
                        <TbCalendarPlus size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  {open && (
                    <Tooltip label={t("team.external.seats.revoke")}>
                      <ActionIcon
                        variant="light"
                        color="red"
                        aria-label={t("team.external.seats.revoke")}
                        loading={
                          revoke.isPending && revoke.variables === seat.id
                        }
                        onClick={() =>
                          modals.openConfirmModal({
                            title: t("team.external.seats.revoke"),
                            children: (
                              <Text size="sm">
                                {t("team.external.seats.revokeConfirm", {
                                  email: seat.email,
                                })}
                              </Text>
                            ),
                            labels: {
                              confirm: t("team.external.seats.revoke"),
                              cancel: t("common.button.cancel"),
                            },
                            confirmProps: { color: "red" },
                            onConfirm: () => revoke.mutate(seat.id),
                          })
                        }
                      >
                        <TbUserX size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
              </Group>

              <Select
                mt="sm"
                label={t("team.external.seats.reminder.label")}
                description={t("team.external.seats.reminder.hint")}
                value={seat.reminderMode ?? "NONE"}
                allowDeselect={false}
                disabled={reminder.isPending}
                data={["NONE", "EMAIL", "PUSH", "BOTH"].map((value) => ({
                  value,
                  label: t(`team.external.seats.reminder.${value}`),
                }))}
                onChange={(mode) => {
                  if (mode && ["NONE", "EMAIL", "PUSH", "BOTH"].includes(mode))
                    reminder.mutate({
                      seatId: seat.id,
                      mode: mode as RevocationReminderMode,
                    });
                }}
              />
              {extending[seat.id] !== undefined && (
                <Group mt="sm" align="end" wrap="wrap">
                  <TextInput
                    type="date"
                    label={t("team.external.seats.endDate")}
                    value={extending[seat.id]}
                    min={minDate}
                    max={maxDate}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setExtending((current) => ({
                        ...current,
                        [seat.id]: value,
                      }));
                    }}
                  />
                  <Button
                    size="sm"
                    loading={extend.isPending}
                    disabled={!extending[seat.id]}
                    onClick={() =>
                      extend.mutate({
                        seatId: seat.id,
                        date: extending[seat.id],
                      })
                    }
                  >
                    {t("common.button.save")}
                  </Button>
                </Group>
              )}

              {seatPreviews.length > 0 && (
                <Stack gap={4} mt="sm">
                  <Text size="xs" fw={600}>
                    {t("team.external.seats.copies", {
                      count: seatPreviews.length,
                    })}
                  </Text>
                  {seatPreviews.map((preview) => (
                    <Group key={preview.id} justify="space-between" gap="xs">
                      <Text size="xs" c="dimmed">
                        {t("team.external.seats.copy", {
                          date: dayjs(preview.createdAt).format("L LT"),
                          pages: preview.pageCount,
                        })}
                      </Text>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        aria-label={t("team.external.seats.removeCopy")}
                        loading={
                          removePreview.isPending &&
                          removePreview.variables === preview.id
                        }
                        onClick={() => removePreview.mutate(preview.id)}
                      >
                        <TbTrash size={14} />
                      </ActionIcon>
                    </Group>
                  ))}
                </Stack>
              )}
            </Paper>
          );
        })}
      </Stack>

      {inviteUrl && (
        <Alert
          color="teal"
          mb="md"
          withCloseButton
          onClose={() => setInviteUrl(null)}
        >
          <Text size="sm" mb="xs">
            {t("team.external.seats.invited")}
          </Text>
          <Group gap="xs" wrap="nowrap">
            <TextInput
              value={inviteUrl}
              readOnly
              style={{ flex: 1, minWidth: 0 }}
              aria-label={t("team.external.seats.inviteLink")}
            />
            <ActionIcon
              variant="light"
              aria-label={t("team.external.seats.copyLink")}
              onClick={async () => {
                if (await copyToClipboard(inviteUrl)) {
                  toast.success(t("team.external.seats.linkCopied"));
                }
              }}
            >
              <TbCopy size={16} />
            </ActionIcon>
          </Group>
        </Alert>
      )}

      {full ? (
        <Alert color="gray">{t("team.external.seats.full")}</Alert>
      ) : (
        <Stack gap="sm">
          <Group grow align="end" wrap="wrap">
            <TextInput
              type="email"
              label={t("team.external.seats.email")}
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
              required
            />
            <TextInput
              label={t("team.external.seats.name")}
              value={displayName}
              maxLength={80}
              onChange={(event) => setDisplayName(event.currentTarget.value)}
            />
            <TextInput
              type="date"
              label={t("team.external.seats.endDate")}
              value={endDate}
              min={minDate}
              max={maxDate}
              onChange={(event) => setEndDate(event.currentTarget.value)}
              required
            />
          </Group>
          <Group justify="flex-end">
            <Button
              loading={invite.isPending}
              disabled={!email.trim() || !endDate}
              onClick={() => invite.mutate()}
            >
              {t("team.external.seats.invite")}
            </Button>
          </Group>
        </Stack>
      )}
    </Paper>
  );
}
