import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  TbArrowLeft,
  TbFingerprint,
  TbLock,
  TbSearch,
  TbShieldLock,
  TbTrash,
} from "react-icons/tb";
import Meta from "../../components/Meta";
import AuditJournalModal from "../../components/team/external/AuditJournalModal";
import RegisterEntryCard, {
  useRegisterDownloads,
} from "../../components/team/external/RegisterEntryCard";
import useTranslate from "../../hooks/useTranslate.hook";
import evidenceVaultService, {
  type VaultTeam,
} from "../../services/evidenceVault.service";
import type { ExternalIssuance } from "../../services/teamExternal.service";
import toast from "../../utils/toast.util";

const STATUS_KEY = ["evidence-vault", "status"];

const errorCode = (error: unknown) =>
  (error as { response?: { data?: { error?: string } } })?.response?.data
    ?.error;

const isLocked = (error: unknown) =>
  (error as { response?: { status?: number } })?.response?.status === 403;

/**
 * Evidence vault of the platform administrators: the register and journal of
 * contractor copies stay reachable for their three years of retention, even
 * when the team or its administrators are gone. It opens with a passkey for a
 * few minutes, and every extraction is written into the journal of the copy.
 */
const EvidenceVault = () => {
  const t = useTranslate();
  const queryClient = useQueryClient();
  const [supported, setSupported] = useState(true);
  const [unlocking, setUnlocking] = useState(false);
  const [needsPasskey, setNeedsPasskey] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(search.trim(), 300);
  const [team, setTeam] = useState<VaultTeam | null>(null);
  const [journalFor, setJournalFor] = useState<ExternalIssuance | null>(null);
  const [eraseOpened, setEraseOpened] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
  }, []);

  const { data: status, isLoading } = useQuery({
    queryKey: STATUS_KEY,
    queryFn: evidenceVaultService.status,
  });
  const open = !!status?.open;

  const shut = () => {
    setTeam(null);
    setJournalFor(null);
    queryClient.setQueryData(STATUS_KEY, { open: false, openUntil: null });
  };

  // The vault shuts by itself: so does the page.
  useEffect(() => {
    if (!status?.openUntil) return;
    const timer = window.setTimeout(
      shut,
      Math.max(0, dayjs(status.openUntil).diff(dayjs())),
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.openUntil]);

  const onVaultError = (error: unknown) => {
    if (isLocked(error)) shut();
  };

  const teams = useQuery({
    queryKey: ["evidence-vault", "teams", debouncedSearch],
    queryFn: () => evidenceVaultService.teams(debouncedSearch),
    enabled: open && !team,
    retry: false,
  });
  const register = useQuery({
    queryKey: ["evidence-vault", "issuances", team?.teamId],
    queryFn: () => evidenceVaultService.issuances(team!.teamId),
    enabled: open && !!team,
    retry: false,
  });
  const journal = useQuery({
    queryKey: ["evidence-vault", "journal", team?.teamId, journalFor?.id],
    queryFn: () => evidenceVaultService.journal(team!.teamId, journalFor!.id),
    enabled: open && !!team && !!journalFor,
    retry: false,
    // Each opening is an extraction, journaled as such: never refetched.
    staleTime: Infinity,
    gcTime: 0,
  });
  useEffect(() => {
    for (const query of [teams, register, journal]) {
      if (query.error) onVaultError(query.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams.error, register.error, journal.error]);

  const downloads = useRegisterDownloads({
    certificate: (row) =>
      evidenceVaultService.certificate(team!.teamId, row.id),
    evidence: (row) => evidenceVaultService.evidence(team!.teamId, row.id),
  });

  const unlock = async () => {
    setUnlocking(true);
    setNeedsPasskey(false);
    try {
      queryClient.setQueryData(STATUS_KEY, await evidenceVaultService.unlock());
    } catch (error) {
      if ((error as Error)?.name === "NotAllowedError") return;
      if (errorCode(error) === "vault_passkey_required") {
        setNeedsPasskey(true);
      } else {
        toast.error(t("admin.vault.unlock.error"));
      }
    } finally {
      setUnlocking(false);
    }
  };

  const lock = async () => {
    await evidenceVaultService.lock().catch(() => undefined);
    shut();
  };

  const closeErase = () => {
    setEraseOpened(false);
    setConfirmation("");
  };

  const erase = async () => {
    if (!team) return;
    setErasing(true);
    try {
      await evidenceVaultService.erase(team.teamId, confirmation);
      toast.success(t("admin.vault.erase.done"));
      closeErase();
      setTeam(null);
      await queryClient.invalidateQueries({
        queryKey: ["evidence-vault", "teams"],
      });
    } catch (error) {
      onVaultError(error);
      toast.error(
        t(
          errorCode(error) === "vault_confirmation_mismatch"
            ? "admin.vault.erase.mismatch"
            : "admin.vault.erase.error",
        ),
      );
    } finally {
      setErasing(false);
    }
  };

  return (
    <>
      <Meta title={t("admin.vault.title")} />
      <Group mb="xs">
        <TbShieldLock size={24} />
        <Title order={3}>{t("admin.vault.title")}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="lg">
        {t("admin.vault.hint")}
      </Text>

      {isLoading ? (
        <Loader size="sm" />
      ) : !open ? (
        <Paper withBorder p="xl">
          <Stack align="center" gap="sm">
            <TbLock size={36} />
            <Text fw={600}>{t("admin.vault.locked.title")}</Text>
            <Text size="sm" c="dimmed" ta="center" maw={480}>
              {t("admin.vault.locked.text")}
            </Text>
            {!supported ? (
              <Alert color="orange">{t("admin.vault.unsupported")}</Alert>
            ) : (
              <Button
                leftSection={<TbFingerprint size={16} />}
                loading={unlocking}
                onClick={unlock}
              >
                {t("admin.vault.unlock")}
              </Button>
            )}
            {needsPasskey && (
              <Alert color="orange">
                {t("admin.vault.passkeyRequired")}{" "}
                <Anchor component={Link} href="/account#passkeys" size="sm">
                  {t("team.audit.passkeys.manage")}
                </Anchor>
              </Alert>
            )}
          </Stack>
        </Paper>
      ) : (
        <Stack gap="md">
          <Group justify="space-between">
            <Badge color="teal" variant="light" size="lg">
              {t("admin.vault.openUntil", {
                time: dayjs(status!.openUntil).format("LT"),
              })}
            </Badge>
            <Button
              variant="light"
              color="gray"
              leftSection={<TbLock size={14} />}
              onClick={lock}
            >
              {t("admin.vault.lock")}
            </Button>
          </Group>

          {!team ? (
            <Paper withBorder p="md">
              <TextInput
                leftSection={<TbSearch size={16} />}
                placeholder={t("admin.vault.search")}
                value={search}
                maxLength={100}
                onChange={(event) => setSearch(event.currentTarget.value)}
                mb="md"
              />
              {teams.isLoading ? (
                <Loader size="sm" />
              ) : !teams.data?.length ? (
                <Text size="sm" c="dimmed">
                  {t("admin.vault.teams.empty")}
                </Text>
              ) : (
                <Table.ScrollContainer minWidth={560}>
                  <Table highlightOnHover verticalSpacing="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t("admin.vault.teams.name")}</Table.Th>
                        <Table.Th>{t("admin.vault.teams.status")}</Table.Th>
                        <Table.Th>{t("admin.vault.teams.copies")}</Table.Th>
                        <Table.Th>{t("admin.vault.teams.last")}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {teams.data.map((row) => (
                        <Table.Tr key={row.teamId}>
                          <Table.Td style={{ overflowWrap: "anywhere" }}>
                            <Anchor
                              component="button"
                              type="button"
                              size="sm"
                              onClick={() => setTeam(row)}
                            >
                              {row.teamName}
                            </Anchor>
                          </Table.Td>
                          <Table.Td>
                            <Badge
                              variant="light"
                              color={row.teamExists ? "blue" : "gray"}
                            >
                              {t(
                                row.teamExists
                                  ? "admin.vault.teams.active"
                                  : "admin.vault.teams.deleted",
                              )}
                            </Badge>
                          </Table.Td>
                          <Table.Td>{row.copies}</Table.Td>
                          <Table.Td>
                            {row.lastIssuedAt
                              ? dayjs(row.lastIssuedAt).format("L")
                              : "-"}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}
            </Paper>
          ) : (
            <Paper withBorder p="md">
              <Group justify="space-between" mb="md">
                <Group gap="xs">
                  <Button
                    variant="subtle"
                    size="xs"
                    leftSection={<TbArrowLeft size={14} />}
                    onClick={() => setTeam(null)}
                  >
                    {t("admin.vault.back")}
                  </Button>
                  <Text fw={600} style={{ overflowWrap: "anywhere" }}>
                    {team.teamName}
                  </Text>
                  <Badge
                    variant="light"
                    color={team.teamExists ? "blue" : "gray"}
                  >
                    {t(
                      team.teamExists
                        ? "admin.vault.teams.active"
                        : "admin.vault.teams.deleted",
                    )}
                  </Badge>
                </Group>
                {!team.teamExists && (
                  <Button
                    variant="light"
                    color="red"
                    size="xs"
                    leftSection={<TbTrash size={14} />}
                    onClick={() => setEraseOpened(true)}
                  >
                    {t("admin.vault.erase.button")}
                  </Button>
                )}
              </Group>
              <Text size="xs" c="dimmed" mb="sm">
                {t("admin.vault.extraction")}
              </Text>
              {register.isLoading ? (
                <Loader size="sm" />
              ) : (
                <Stack gap="xs">
                  {(register.data ?? []).map((row) => (
                    <RegisterEntryCard
                      key={row.id}
                      row={row}
                      // Titles stay encrypted under the team audit key.
                      title={null}
                      downloads={downloads}
                      onJournal={() => setJournalFor(row)}
                    />
                  ))}
                </Stack>
              )}
            </Paper>
          )}
        </Stack>
      )}

      <AuditJournalModal
        opened={!!journalFor}
        onClose={() => setJournalFor(null)}
        journal={journal.data}
      />

      <Modal
        opened={eraseOpened}
        onClose={closeErase}
        title={t("admin.vault.erase.title")}
      >
        <Stack gap="sm">
          <Text size="sm">{t("admin.vault.erase.text")}</Text>
          <TextInput
            label={t("admin.vault.erase.label", { name: team?.teamName ?? "" })}
            value={confirmation}
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            autoComplete="off"
          />
          <Group justify="right">
            <Button variant="default" onClick={closeErase}>
              {t("common.button.cancel")}
            </Button>
            <Button
              color="red"
              loading={erasing}
              disabled={confirmation !== team?.teamName}
              onClick={erase}
            >
              {t("admin.vault.erase.confirm")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
};

export default EvidenceVault;
