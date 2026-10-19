import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useModals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { TbFingerprint, TbPlus, TbTrash } from "react-icons/tb";
import useUser from "../../hooks/user.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import passkeyService from "../../services/passkey.service";
import signingService from "../../services/signing.service";
import toast from "../../utils/toast.util";
import { PASSKEYS_QUERY_KEY } from "../team/external/ApprovalPasskeyRequired";

const SIGNING_PASSKEYS_QUERY_KEY = ["signing-passkeys"];
const REAUTH_RETURN_ITEM = "privcloud_reauth_return";

/** Before leaving for the provider: the return is for a passkey, not 2FA. */
export function rememberPasskeyReauthIntent() {
  try {
    window.sessionStorage.setItem(REAUTH_RETURN_ITEM, "1");
  } catch {
    // Without storage the return simply opens nothing.
  }
}

export function takePasskeyReauthIntent(): boolean {
  try {
    const pending = window.sessionStorage.getItem(REAUTH_RETURN_ITEM) === "1";
    window.sessionStorage.removeItem(REAUTH_RETURN_ITEM);
    return pending;
  } catch {
    return false;
  }
}

type Row = {
  id: string;
  kind: "account" | "signing";
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string;
};

/**
 * Every passkey of the account: those added here and those enrolled during
 * an electronic signature. All of them sign in, sign documents (signing
 * ones) and approve the copies issued to contractors.
 */
const PasskeysSection = ({
  linkedProviders,
  onReauth,
  reauthReturned,
}: {
  // OAuth providers linked to the account, for accounts without a password.
  linkedProviders: string[];
  onReauth: (_provider: string) => void;
  // Back from a fresh linked sign-in started to add a passkey.
  reauthReturned: boolean;
}) => {
  const t = useTranslate();
  const modals = useModals();
  const queryClient = useQueryClient();
  const { user } = useUser();
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const section = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reauthReturned) setConfirming(true);
  }, [reauthReturned]);

  const { data: account } = useQuery({
    queryKey: PASSKEYS_QUERY_KEY,
    queryFn: passkeyService.list,
  });
  const { data: signing } = useQuery({
    queryKey: SIGNING_PASSKEYS_QUERY_KEY,
    queryFn: signingService.listSigningPasskeys,
  });

  // Reached from the team register through /account#passkeys.
  useEffect(() => {
    if (window.location.hash === "#passkeys" && account) {
      section.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [account]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: SIGNING_PASSKEYS_QUERY_KEY }),
    ]);

  const deleteMutation = useMutation({
    mutationFn: (row: Row) =>
      row.kind === "account"
        ? passkeyService.remove(row.id)
        : signingService.deleteSigningPasskey(row.id),
    onSuccess: async () => {
      toast.success(t("account.card.signing-passkeys.deleted"));
      await refresh();
    },
    onError: toast.axiosError,
  });

  const closeConfirm = () => {
    setConfirming(false);
    setPassword("");
    setCode("");
  };

  const add = async () => {
    setAdding(true);
    try {
      await passkeyService.register({
        password: password || undefined,
        code: code.trim() || undefined,
      });
      toast.success(t("account.card.passkeys.added"));
      closeConfirm();
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      // Closing the browser prompt is not worth a red toast.
      if ((error as Error)?.name === "NotAllowedError") return;
      toast.error(
        t(
          status === 403
            ? "account.card.passkeys.wrong-proof"
            : status === 400
              ? "account.card.passkeys.wrong-code"
              : "account.card.passkeys.add-error",
        ),
      );
    } finally {
      setAdding(false);
      await refresh();
    }
  };

  const needsCode = !!user?.totpVerified;
  const usesPassword = !!user?.hasPassword && !reauthReturned;

  const rows: Row[] = [
    ...(account?.passkeys ?? []).map((passkey) => ({
      ...passkey,
      kind: "account" as const,
    })),
    ...(signing ?? []).map((passkey) => ({
      ...passkey,
      kind: "signing" as const,
    })),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  const confirmDelete = (row: Row) =>
    modals.openConfirmModal({
      title: t("account.card.signing-passkeys.confirm.title"),
      children: (
        <Text size="sm">
          {t(
            row.kind === "account"
              ? "account.card.passkeys.confirm"
              : "account.card.signing-passkeys.confirm.text",
          )}
        </Text>
      ),
      labels: {
        confirm: t("account.card.signing-passkeys.delete"),
        cancel: t("common.button.cancel"),
      },
      confirmProps: { color: "red" },
      onConfirm: () => deleteMutation.mutate(row),
    });

  return (
    <Paper withBorder p="xl" mt="lg" id="passkeys" ref={section}>
      <Title order={5} mb="xs">
        {t("account.card.passkeys.title")}
      </Title>
      <Text size="sm" c="dimmed" mb="md">
        {t("account.card.passkeys.description")}
      </Text>
      <Stack gap="sm">
        {rows.length === 0 && (
          <Text size="sm" c="dimmed">
            {t("account.card.passkeys.empty")}
          </Text>
        )}
        {rows.map((row) => (
          <Group key={row.id} justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              <TbFingerprint size={20} />
              <Stack gap={2}>
                <Group gap="xs">
                  <Text size="sm">
                    {t("account.card.signing-passkeys.created", {
                      date: new Date(row.createdAt).toLocaleDateString(),
                    })}
                  </Text>
                  <Badge size="xs" variant="light">
                    {row.deviceType === "multiDevice"
                      ? t("account.card.signing-passkeys.synced")
                      : t("account.card.signing-passkeys.device-bound")}
                  </Badge>
                  <Badge
                    size="xs"
                    variant="light"
                    color={row.kind === "signing" ? "grape" : "blue"}
                  >
                    {t(
                      row.kind === "signing"
                        ? "account.card.passkeys.origin.signing"
                        : "account.card.passkeys.origin.account",
                    )}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed">
                  {row.lastUsedAt
                    ? t("account.card.signing-passkeys.last-used", {
                        date: new Date(row.lastUsedAt).toLocaleDateString(),
                      })
                    : t("account.card.signing-passkeys.never-used")}
                </Text>
              </Stack>
            </Group>
            <Button
              variant="light"
              color="red"
              size="xs"
              leftSection={<TbTrash size={14} />}
              loading={
                deleteMutation.isPending &&
                deleteMutation.variables?.id === row.id
              }
              onClick={() => confirmDelete(row)}
            >
              {t("account.card.signing-passkeys.delete")}
            </Button>
          </Group>
        ))}
        <Group justify="right">
          <Button
            variant="light"
            leftSection={<TbPlus size={14} />}
            onClick={() => setConfirming(true)}
          >
            {t("account.card.passkeys.add")}
          </Button>
        </Group>
      </Stack>
      <Modal
        opened={confirming}
        onClose={closeConfirm}
        title={t("account.card.passkeys.add")}
      >
        <Stack gap="sm">
          <Text size="sm">{t("account.card.passkeys.confirm-hint")}</Text>
          {!usesPassword && !reauthReturned ? (
            linkedProviders.length > 0 ? (
              <Group>
                {linkedProviders.map((provider) => (
                  <Button
                    key={provider}
                    variant="light"
                    onClick={() => onReauth(provider)}
                  >
                    {t("account.card.security.totp.oauth.confirm", {
                      provider: t(`account.card.oauth.${provider}`),
                    })}
                  </Button>
                ))}
              </Group>
            ) : (
              <Alert color="orange">
                {t("account.card.security.totp.oauth.none")}
              </Alert>
            )
          ) : (
            <>
              {usesPassword && (
                <PasswordInput
                  label={t("account.card.password.title")}
                  value={password}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                  autoComplete="current-password"
                />
              )}
              {needsCode && (
                <TextInput
                  label={t("account.modal.totp.codeOrBackup")}
                  placeholder="123456 / A1B2C3D4"
                  value={code}
                  onChange={(event) => setCode(event.currentTarget.value)}
                  autoComplete="one-time-code"
                />
              )}
              <Group justify="right">
                <Button
                  leftSection={<TbFingerprint size={14} />}
                  loading={adding}
                  disabled={
                    (usesPassword && !password) ||
                    (needsCode && code.trim().length < 6)
                  }
                  onClick={add}
                >
                  {t("account.card.passkeys.create")}
                </Button>
              </Group>
            </>
          )}
        </Stack>
      </Modal>
    </Paper>
  );
};

export default PasskeysSection;
