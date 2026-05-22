import {
  Alert,
  Badge,
  Button,
  Center,
  Code,
  Container,
  Divider,
  Group,
  NumberInput,
  Paper,
  PasswordInput,
  Radio,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { yupResolver } from "mantine-form-yup-resolver";
import { useModals } from "@mantine/modals";
import { useEffect, useState } from "react";
import {
  TbAuth2Fa,
  TbCopy,
  TbCheck,
  TbExternalLink,
  TbEye,
  TbEyeOff,
  TbFingerprint,
  TbKey,
  TbShieldLock,
  TbUsersGroup,
} from "react-icons/tb";
import { FormattedMessage, useIntl } from "react-intl";
import * as yup from "yup";
import Meta from "../../components/Meta";
import LanguagePicker from "../../components/account/LanguagePicker";
import PushNotificationSection from "../../components/account/PushNotificationSection";
import ThemeSwitcher from "../../components/account/ThemeSwitcher";
import showEnableTotpModal from "../../components/account/showEnableTotpModal";
import useTranslate from "../../hooks/useTranslate.hook";
import useUser from "../../hooks/user.hook";
import authService from "../../services/auth.service";
import userService from "../../services/user.service";
import { getOAuthIcon, getOAuthUrl, unlinkOAuth } from "../../utils/oauth.util";
import toast from "../../utils/toast.util";
import { copyToClipboard } from "../../utils/clipboard.util";
import { useQuery } from "@tanstack/react-query";
import {
  generateEncryptionKey,
  exportKeyToBase64,
  importKeyFromBase64,
  computeKeyHash,
  computeKeyHashFromEncoded,
  computeKeyHashFromEncodedLegacy,
  getUserKey,
  storeUserKey,
  removeUserKey,
  isPasskeyPrfAvailable,
  saveKeyWithPasskey,
  loadKeyWithPasskey,
  hasPasskeyWrappedKey,
  removePasskeyWrappedKey,
} from "../../utils/crypto.util";
import SSKRGenerateModal from "../../components/auth/SSKRGenerateModal";
import ReencryptModal from "../../components/account/ReencryptModal";
import CreateTeamModal from "../../components/team/CreateTeamModal";
import teamService from "../../services/team.service";
import { combineShards } from "../../utils/sskr.util";

// ---- E2E Encryption Section ----------------------------------------------------------------
const E2EEncryptionSection = ({ refreshUser }: { refreshUser: () => void }) => {
  const modals = useModals();
  const intl = useIntl();
  const { user } = useUser();

  const [localKey, setLocalKey] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const [generating, setGenerating] = useState(false);

  // SSKR
  const [showSSKR, setShowSSKR] = useState(false);
  const [sskrKey, setSskrKey] = useState<string | null>(null);
  const [showRecover, setShowRecover] = useState(false);
  const [shardCount, setShardCount] = useState(3);
  const [shardValues, setShardValues] = useState<string[]>(["", "", ""]);
  const [recoverError, setRecoverError] = useState("");
  const [recoveringShards, setRecoveringShards] = useState(false);

  // Re-encryption on key rotation
  const [showReencrypt, setShowReencrypt] = useState(false);
  const [oldKeyForReencrypt, setOldKeyForReencrypt] = useState("");
  const [newKeyForReencrypt, setNewKeyForReencrypt] = useState("");

  // Passkey / WebAuthn PRF keychain
  const [showPasskeyOffer, setShowPasskeyOffer] = useState(false);
  const [savingPasskey, setSavingPasskey] = useState(false);
  const [loadingPasskey, setLoadingPasskey] = useState(false);
  const [passkeyWrappedExists, setPasskeyWrappedExists] = useState(false);
  const [passkeyPrfSupported, setPasskeyPrfSupported] = useState(false);

  // Initialiser l'état de la clé wrappée et la disponibilité PRF au montage
  useEffect(() => {
    setPasskeyWrappedExists(hasPasskeyWrappedKey());
    isPasskeyPrfAvailable().then(setPasskeyPrfSupported);
  }, []);

  // Sync localStorage key into component state
  useEffect(() => {
    setLocalKey(getUserKey());
  }, []);

  const hasServerKey = !!user?.hasEncryptionKey;
  const hasLocalKey = !!localKey;

  // --- Generate a new key ---------------------------------------------------------------
  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const previousKey = getUserKey();
      const key = await generateEncryptionKey();
      const encoded = await exportKeyToBase64(key);
      const hash = await computeKeyHash(key, user!.id);

      if (previousKey) {
        // Key rotation: save both keys and start re-encryption
        setOldKeyForReencrypt(previousKey);
        setNewKeyForReencrypt(encoded);
        // Store new key + hash immediately (so the server-side hash matches)
        await userService.setEncryptionKeyHash(hash);
        storeUserKey(encoded);
        setLocalKey(encoded);
        setShowReencrypt(true);
      } else {
        // First-time generation: no re-encryption needed
        await userService.setEncryptionKeyHash(hash);
        storeUserKey(encoded);
        setLocalKey(encoded);
        setSskrKey(encoded);
        setShowSSKR(true);
        refreshUser();
        toast.success(intl.formatMessage({ id: "account.e2e.toast.generated" }));
        // Proposer le coffre-fort système si WebAuthn PRF disponible
        const prfAvailable = await isPasskeyPrfAvailable();
        if (prfAvailable) {
          setShowPasskeyOffer(true);
        }
      }
    } catch (e: any) {
      toast.error(e?.message ?? intl.formatMessage({ id: "account.e2e.toast.generateError" }));
    } finally {
      setGenerating(false);
    }
  };

  // Re-encryption callbacks
  const handleReencryptSuccess = () => {
    setShowReencrypt(false);
    setSskrKey(newKeyForReencrypt || localKey);
    setShowSSKR(true);
    refreshUser();
    toast.success(intl.formatMessage({ id: "account.e2e.toast.reencrypted" }));
  };

  const handleReencryptError = (err: string) => {
    setShowReencrypt(false);
    toast.error(intl.formatMessage({ id: "account.e2e.toast.reencryptError" }, { error: err }));
    refreshUser();
  };

  // --- SSKR recovery from shards ---
  const updateShardCount = (v: string | number) => {
    const n = typeof v === "number" ? Math.max(2, Math.min(10, v)) : 3;
    setShardCount(n);
    setShardValues((prev) => {
      const next = [...prev];
      while (next.length < n) next.push("");
      return next.slice(0, n);
    });
  };

  const handleRecoverFromShards = async () => {
    setRecoverError("");
    const filled = shardValues.filter((s) => s.trim().length > 0);
    if (filled.length < 2) {
      setRecoverError(intl.formatMessage({ id: "account.e2e.recover.minShards" }));
      return;
    }
    setRecoveringShards(true);
    try {
      const encodedKey = combineShards(filled);
      await importKeyFromBase64(encodedKey);
      const hash = await computeKeyHashFromEncoded(encodedKey, user!.id);
      let valid = await userService.verifyEncryptionKey(hash);
      if (!valid) {
        const legacyHash = await computeKeyHashFromEncodedLegacy(encodedKey);
        valid = await userService.verifyEncryptionKey(legacyHash);
        if (!valid) {
          setRecoverError(
            intl.formatMessage({ id: "account.e2e.recover.mismatch" }),
          );
          return;
        }
        await userService.setEncryptionKeyHash(hash);
      }
      storeUserKey(encodedKey);
      setLocalKey(encodedKey);
      setShowRecover(false);
      toast.success(intl.formatMessage({ id: "account.e2e.toast.recovered" }));
    } catch (e: any) {
      setRecoverError(e?.message ?? intl.formatMessage({ id: "account.e2e.recover.error" }));
    } finally {
      setRecoveringShards(false);
    }
  };

  // --- Confirm-then-generate (warns about re-encryption time)
  const confirmRegenerate = () => {
    modals.openConfirmModal({
      title: intl.formatMessage({ id: "account.e2e.confirm.regenerate.title" }),
      children: (
        <Text size="sm">
          <FormattedMessage id="account.e2e.confirm.regenerate.body" />
        </Text>
      ),
      labels: {
        confirm: intl.formatMessage({ id: "account.e2e.confirm.regenerate.confirm" }),
        cancel: intl.formatMessage({ id: "common.button.cancel" }),
      },
      confirmProps: { color: "red" },
      onConfirm: handleGenerate,
    });
  };

  // --- Import an existing key (for new browser / device) ----------------
  const handleImport = async () => {
    setImportError("");
    // Strip everything that is not a valid base64url character.
    // Prevents invisible chars (ZWSP, NBSP, newlines …) from corrupting
    // the decoded bytes and producing a different SHA-256 hash.
    const sanitized = importValue.replace(/[^A-Za-z0-9_-]/g, "");
    if (!sanitized) {
      setImportError(intl.formatMessage({ id: "account.e2e.import.emptyError" }));
      return;
    }
    setImporting(true);
    try {
      // Validate the key format by trying to import it
      await importKeyFromBase64(sanitized);
      // Compute hash and verify against server
      const hash = await computeKeyHashFromEncoded(sanitized, user!.id);
      let valid = await userService.verifyEncryptionKey(hash);
      if (!valid) {
        // Fallback: le hash stocké est peut-être encore en legacy SHA-256
        const legacyHash = await computeKeyHashFromEncodedLegacy(sanitized);
        valid = await userService.verifyEncryptionKey(legacyHash);
        if (!valid) {
          console.debug(
            "[E2E import] verification failed -- submitted hash:",
            hash.slice(0, 8) + "…",
            "key length:",
            sanitized.length,
          );
          setImportError(
            intl.formatMessage({ id: "account.e2e.import.mismatchError" }),
          );
          return;
        }
        // Migration: remplacer le hash legacy par HMAC-SHA256
        await userService.setEncryptionKeyHash(hash);
      }
      storeUserKey(sanitized);
      setLocalKey(sanitized);
      setImportValue("");
      toast.success(intl.formatMessage({ id: "account.e2e.toast.imported" }));
    } catch (e: any) {
      setImportError(e?.message ?? intl.formatMessage({ id: "account.e2e.import.invalidError" }));
    } finally {
      setImporting(false);
    }
  };

  // --- Revoke key --------------------------------------------------------
  const handleRevoke = () => {
    modals.openConfirmModal({
      title: intl.formatMessage({ id: "account.e2e.confirm.revoke.title" }),
      children: (
        <Text size="sm">
          <FormattedMessage
            id="account.e2e.confirm.revoke.body"
            values={{
              strong: (chunks) => <strong>{chunks}</strong>,
            }}
          />
        </Text>
      ),
      labels: {
        confirm: intl.formatMessage({ id: "account.e2e.confirm.revoke.confirm" }),
        cancel: intl.formatMessage({ id: "common.button.cancel" }),
      },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await userService.removeEncryptionKey();
          removeUserKey();
          removePasskeyWrappedKey();
          setPasskeyWrappedExists(false);
          setShowPasskeyOffer(false);
          setLocalKey(null);
          refreshUser();
          toast.success(intl.formatMessage({ id: "account.e2e.toast.revoked" }));
        } catch (e: any) {
          toast.error(e?.message ?? intl.formatMessage({ id: "account.e2e.toast.revokeError" }));
        }
      },
    });
  };

  // --- Passkey keychain handlers -------------------------------------------------
  const handleSavePasskey = async () => {
    if (!localKey || !user) return;
    setSavingPasskey(true);
    try {
      const wrappedData = await saveKeyWithPasskey(localKey, user.id, user.email);
      if (wrappedData) {
        // Sync wrapped key to server for multi-device access
        await userService.setWrappedKey(wrappedData).catch(() => {
          // Non-critical: localStorage has it, server sync can retry later
        });
        setShowPasskeyOffer(false);
        setPasskeyWrappedExists(true);
        toast.success(intl.formatMessage({ id: "account.e2e.passkey.save.success" }));
      } else {
        toast.error(intl.formatMessage({ id: "account.e2e.passkey.unsupported" }));
      }
    } catch {
      toast.error(intl.formatMessage({ id: "account.e2e.passkey.save.error" }));
    } finally {
      setSavingPasskey(false);
    }
  };

  const handleLoadPasskey = async () => {
    setLoadingPasskey(true);
    try {
      // Fetch server-side wrapped keys for multi-device recovery
      const serverKeys = await userService.listWrappedKeys().catch(() => []);
      const encodedKey = await loadKeyWithPasskey(serverKeys);
      if (!encodedKey) {
        toast.error(intl.formatMessage({ id: "account.e2e.passkey.load.error" }));
        return;
      }
      // Vérifier que la clé restaurée correspond bien au hash serveur
      const hash = await computeKeyHashFromEncoded(encodedKey, user!.id);
      const valid = await userService.verifyEncryptionKey(hash);
      if (!valid) {
        toast.error(intl.formatMessage({ id: "account.e2e.import.mismatchError" }));
        return;
      }
      storeUserKey(encodedKey);
      setLocalKey(encodedKey);
      toast.success(intl.formatMessage({ id: "account.e2e.passkey.load.success" }));
    } catch {
      toast.error(intl.formatMessage({ id: "account.e2e.passkey.load.error" }));
    } finally {
      setLoadingPasskey(false);
    }
  };

  // Masked display of the key
  const maskedKey = localKey
    ? localKey.slice(0, 8) + "••••••••••••" + localKey.slice(-8)
    : null;

  return (
    <Paper withBorder p="xl" mt="lg">
      <Group mb="xs" gap="xs">
        <TbShieldLock size={20} />
        <Title order={5}>
          <FormattedMessage id="account.e2e.title" />
        </Title>
      </Group>

      <Text size="sm" c="dimmed" mb="md">
        <FormattedMessage id="account.e2e.description" />
      </Text>

      {/* --- Key exists locally ---------------------------------------------------- */}
      {hasLocalKey && localKey && (
        <Stack gap="xs">
          <Group gap="xs">
            <TbKey size={16} />
            <Text size="sm" fw={500}>
              <FormattedMessage id="account.e2e.yourKey" />
            </Text>
          </Group>
          <Group gap="xs">
            <Code
              block
              style={{
                flex: 1,
                wordBreak: "break-all",
                fontSize: "0.75rem",
                userSelect: revealKey ? "all" : "none",
              }}
            >
              {revealKey ? localKey : maskedKey}
            </Code>
            <Tooltip label={intl.formatMessage({ id: revealKey ? "account.e2e.key.hide" : "account.e2e.key.reveal" })}>
              <Button
                variant="subtle"
                size="xs"
                px={6}
                onClick={() => setRevealKey((v) => !v)}
              >
                {revealKey ? <TbEyeOff size={16} /> : <TbEye size={16} />}
              </Button>
            </Tooltip>
            <Tooltip label={intl.formatMessage({ id: copiedKey ? "account.e2e.key.copied" : "account.e2e.key.copy" })}>
              <Button
                variant="subtle"
                size="xs"
                px={6}
                onClick={async () => {
                  const ok = await copyToClipboard(localKey);
                  if (ok) {
                    setCopiedKey(true);
                    setTimeout(() => setCopiedKey(false), 1500);
                  }
                }}
              >
                {copiedKey ? (
                  <TbCheck size={16} color="teal" />
                ) : (
                  <TbCopy size={16} />
                )}
              </Button>
            </Tooltip>
          </Group>

          <Group justify="right" mt="sm">
            <Button
              variant="light"
              color="orange"
              size="xs"
              onClick={confirmRegenerate}
              loading={generating}
            >
              <FormattedMessage id="account.e2e.button.regenerate" />
            </Button>
            <Button
              variant="light"
              color="red"
              size="xs"
              onClick={handleRevoke}
            >
              <FormattedMessage id="account.e2e.button.revoke" />
            </Button>
            <Button
              variant="light"
              size="xs"
              onClick={() => {
                setSskrKey(localKey);
                setShowSSKR(true);
              }}
            >
              <FormattedMessage id="account.e2e.button.sskr" />
            </Button>
          </Group>

          {/* --- Coffre-fort système via WebAuthn PRF --- */}
          {/* Affiché uniquement si le navigateur supporte WebAuthn PRF */}
          {passkeyPrfSupported && (showPasskeyOffer ? (
            <Alert
              mt="sm"
              icon={<TbFingerprint size={18} />}
              title={intl.formatMessage({ id: "account.e2e.passkey.offer" })}
              color="blue"
              withCloseButton
              onClose={() => setShowPasskeyOffer(false)}
            >
              <Text size="xs" mb="sm">
                <FormattedMessage id="account.e2e.passkey.offer.description" />
              </Text>
              <Group gap="xs">
                <Button
                  size="xs"
                  leftSection={<TbFingerprint size={14} />}
                  loading={savingPasskey}
                  onClick={handleSavePasskey}
                >
                  <FormattedMessage id="account.e2e.passkey.save" />
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => setShowPasskeyOffer(false)}
                >
                  <FormattedMessage id="account.e2e.passkey.skip" />
                </Button>
              </Group>
            </Alert>
          ) : (
            <Group justify="right" mt="xs">
              <Button
                variant="subtle"
                size="xs"
                color={passkeyWrappedExists ? "teal" : "blue"}
                leftSection={<TbFingerprint size={14} />}
                loading={savingPasskey}
                onClick={passkeyWrappedExists ? undefined : handleSavePasskey}
                disabled={passkeyWrappedExists}
              >
                {passkeyWrappedExists
                  ? intl.formatMessage({ id: "account.e2e.passkey.saved" })
                  : intl.formatMessage({ id: "account.e2e.passkey.save" })}
              </Button>
            </Group>
          ))}
        </Stack>
      )}

      {/* --- Server has key hash but nothing locally (new device) --- */}
      {hasServerKey && !hasLocalKey && (
        <Stack gap="xs">
          <Text size="sm" color="yellow">
            <FormattedMessage id="account.e2e.import.warning" />
          </Text>

          {/* Restauration depuis le trousseau système si disponible */}
          {passkeyWrappedExists && (
            <Button
              variant="light"
              color="blue"
              size="sm"
              leftSection={<TbFingerprint size={16} />}
              loading={loadingPasskey}
              onClick={handleLoadPasskey}
            >
              <FormattedMessage id="account.e2e.passkey.load" />
            </Button>
          )}

          <form onSubmit={(e) => { e.preventDefault(); handleImport(); }}>
          <Group align="flex-end" gap="xs">
            <PasswordInput
              style={{ flex: 1 }}
              label={intl.formatMessage({ id: "account.e2e.import.label" })}
              placeholder={intl.formatMessage({ id: "account.e2e.import.placeholder" })}
              value={importValue}
              onChange={(e) => {
                setImportValue(e.currentTarget.value);
                setImportError("");
              }}
              error={importError}
            />
            <Button type="submit" loading={importing} size="sm">
              <FormattedMessage id="account.e2e.import.submit" />
            </Button>
          </Group>
          </form>
          <Divider label={intl.formatMessage({ id: "e2ePrompt.divider.or" })} labelPosition="center" my="xs" />

          <Button
            variant="subtle"
            size="compact-sm"
            onClick={() => setShowRecover(!showRecover)}
          >
            {showRecover
              ? intl.formatMessage({ id: "account.e2e.recover.backDirect" })
              : intl.formatMessage({ id: "account.e2e.recover.sskrLink" })}
          </Button>

          {showRecover && (
            <Stack gap="xs">
              <NumberInput
                label={intl.formatMessage({ id: "e2ePrompt.recover.shardCount" })}
                value={shardCount}
                onChange={updateShardCount}
                min={2}
                max={10}
                size="sm"
              />
              {Array.from({ length: shardCount }, (_, i) => (
                <PasswordInput
                  key={i}
                  label={intl.formatMessage({ id: "e2ePrompt.recover.shard" }, { n: i + 1 })}
                  placeholder="sskr:..."
                  value={shardValues[i] ?? ""}
                  onChange={(e) => {
                    const next = [...shardValues];
                    next[i] = e.currentTarget.value;
                    setShardValues(next);
                    setRecoverError("");
                  }}
                  size="sm"
                />
              ))}
              <div role="alert" aria-live="assertive">
                {recoverError && (
                  <Text size="xs" color="red">
                    {recoverError}
                  </Text>
                )}
              </div>
              <Group justify="right">
                <Button
                  onClick={handleRecoverFromShards}
                  loading={recoveringShards}
                >
                  <FormattedMessage id="e2ePrompt.recover.submit" />
                </Button>
              </Group>
            </Stack>
          )}

          <Group justify="right" mt="xs">
            <Button
              variant="light"
              color="red"
              size="xs"
              onClick={handleRevoke}
            >
              <FormattedMessage id="account.e2e.button.revokeAndCreate" />
            </Button>
          </Group>
        </Stack>
      )}

      {/* --- No key at all ---------------------------------- */}
      {!hasServerKey && !hasLocalKey && (
        <Stack gap="xs">
          <Text size="sm">
            <FormattedMessage id="account.e2e.noKey" />
          </Text>
          <Group justify="right">
            <Button
              leftSection={<TbKey size={16} />}
              onClick={handleGenerate}
              loading={generating}
            >
              <FormattedMessage id="account.e2e.button.generate" />
            </Button>
          </Group>
        </Stack>
      )}

      <SSKRGenerateModal
        opened={showSSKR}
        onClose={() => setShowSSKR(false)}
        encodedKey={sskrKey ?? ""}
      />

      <ReencryptModal
        opened={showReencrypt}
        oldKey={oldKeyForReencrypt}
        newKey={newKeyForReencrypt}
        onSuccess={handleReencryptSuccess}
        onError={handleReencryptError}
      />
    </Paper>
  );
};

// ---- Main Account page ------------------------------------------------------------------------
const Account = () => {
  const [oauth, setOAuth] = useState<string[]>([]);
  const [oauthStatus, setOAuthStatus] = useState<Record<
    string,
    {
      provider: string;
      providerUsername: string;
    }
  > | null>(null);

  const [isDeleting, setIsDeleting] = useState(false);
  const [showCreateTeam, setShowCreateTeam] = useState(false);

  const { data: teamStatus } = useQuery({
    queryKey: ["teams.status"],
    queryFn: () => teamService.getTeamStatus(),
    enabled: true,
    staleTime: 120_000,
  });

  const { user, refreshUser } = useUser();
  const modals = useModals();
  const t = useTranslate();

  const accountForm = useForm({
    initialValues: {
      username: user?.username,
      email: user?.email,
    },
    validate: yupResolver(
      yup.object().shape({
        email: yup.string().email(t("common.error.invalid-email")),
        username: yup
          .string()
          .min(3, t("common.error.too-short", { length: 3 })),
      }),
    ),
  });

  const passwordForm = useForm({
    initialValues: {
      oldPassword: "",
      password: "",
    },
    validate: yupResolver(
      yup.object().shape({
        oldPassword: yup.string().when([], {
          is: () => !!user?.hasPassword,
          then: (schema) =>
            schema
              .min(8, t("common.error.too-short", { length: 8 }))
              .required(t("common.error.field-required")),
          otherwise: (schema) => schema.notRequired(),
        }),
        password: yup
          .string()
          .min(8, t("common.error.too-short", { length: 8 }))
          .required(t("common.error.field-required")),
      }),
    ),
  });

  const enableTotpForm = useForm({
    initialValues: {
      password: "",
    },
    validate: yupResolver(
      yup.object().shape({
        password: yup
          .string()
          .min(8, t("common.error.too-short", { length: 8 }))
          .required(t("common.error.field-required")),
      }),
    ),
  });

  const disableTotpForm = useForm({
    initialValues: {
      password: "",
      code: "",
    },
    validate: yupResolver(
      yup.object().shape({
        password: yup.string().min(8),
        code: yup
          .string()
          .min(6, t("common.error.too-short", { length: 6 }))
          .max(8)
          .required(t("common.error.field-required")),
      }),
    ),
  });

  const refreshOAuthStatus = () => {
    authService
      .getOAuthStatus()
      .then((data) => {
        setOAuthStatus(data.data);
      })
      .catch(toast.axiosError);
  };

  useEffect(() => {
    authService
      .getAvailableOAuth()
      .then((data) => {
        setOAuth(data.data);
      })
      .catch(toast.axiosError);
    refreshOAuthStatus();
  }, []);

  return (
    <>
      <Meta title={t("account.title")} />
      <Container size="lg" className="account-settings">
        <Title order={3} mb="xs">
          <FormattedMessage id="account.title" />
        </Title>
        {/* Team members: show Team badge */}
        {teamStatus?.isTeamMember && !user?.isAdmin && (
          <Paper withBorder p="lg" mb="md">
            <Text fw={700} size="md" mb="sm">
              <FormattedMessage id="account.title" /> - Teams
            </Text>
            {(teamStatus.teams || []).map((t) => (
              <Paper key={t.teamId} withBorder p="sm" mb="xs">
                <Group justify="space-between">
                  <Badge size="md" color="violet" variant="filled">
                    Team - {t.teamName}
                  </Badge>
                  <Badge size="sm" variant="light" color={t.role === "OWNER" ? "violet" : t.role === "ADMIN" ? "blue" : "gray"}>
                    {t.role === "OWNER" ? "Propriétaire" : t.role === "ADMIN" ? "Admin" : "Membre"}
                  </Badge>
                </Group>
              </Paper>
            ))}
          </Paper>
        )}
        <Paper withBorder p="xl">
          <Title order={5} mb="xs">
            <FormattedMessage id="account.card.info.title" />
            {user?.isLdap ? (
              <Badge style={{ marginLeft: "1em" }}>LDAP</Badge>
            ) : null}
          </Title>
          <form
            onSubmit={accountForm.onSubmit((values) =>
              userService
                .updateCurrentUser({
                  username: values.username,
                  email: values.email,
                })
                .then(() => toast.success(t("account.notify.info.success")))
                .catch(toast.axiosError),
            )}
          >
            <Stack>
              <TextInput
                label={t("account.card.info.username")}
                disabled={user?.isLdap}
                {...accountForm.getInputProps("username")}
              />
              <TextInput
                label={t("account.card.info.email")}
                disabled={user?.isLdap}
                {...accountForm.getInputProps("email")}
              />
              {!user?.isLdap && (
                <Group justify="right">
                  <Button type="submit">
                    <FormattedMessage id="common.button.save" />
                  </Button>
                </Group>
              )}
            </Stack>
          </form>
        </Paper>
        {user?.isLdap ? null : (
          <Paper withBorder p="xl" mt="lg">
            <Title order={5} mb="xs">
              <FormattedMessage id="account.card.password.title" />
            </Title>
            <form
              onSubmit={passwordForm.onSubmit((values) =>
                authService
                  .updatePassword(values.oldPassword, values.password)
                  .then(async () => {
                    refreshUser();
                    toast.success(t("account.notify.password.success"));
                    passwordForm.reset();
                  })
                  .catch(toast.axiosError),
              )}
            >
              <Stack>
                {user?.hasPassword ? (
                  <PasswordInput
                    label={t("account.card.password.old")}
                    {...passwordForm.getInputProps("oldPassword")}
                  />
                ) : (
                  <Text size="sm" c="dimmed">
                    <FormattedMessage id="account.card.password.noPasswordSet" />
                  </Text>
                )}
                <PasswordInput
                  label={t("account.card.password.new")}
                  {...passwordForm.getInputProps("password")}
                />
                <Group justify="right">
                  <Button type="submit">
                    <FormattedMessage id="common.button.save" />
                  </Button>
                </Group>
              </Stack>
            </form>
          </Paper>
        )}
        {oauth.length > 0 && (
          <Paper withBorder p="xl" mt="lg">
            <Title order={5} mb="xs">
              <FormattedMessage id="account.card.oauth.title" />
            </Title>

            <Tabs defaultValue={oauth[0] || ""}>
              <Tabs.List>
                {oauth.map((provider) => (
                  <Tabs.Tab
                    value={provider}
                    leftSection={getOAuthIcon(provider)}
                    key={provider}
                  >
                    {t(`account.card.oauth.${provider}`)}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
              {oauth.map((provider) => (
                <Tabs.Panel value={provider} pt="xs" key={provider}>
                  <Group justify="space-between">
                    <Text>
                      {oauthStatus?.[provider]
                        ? oauthStatus[provider].providerUsername
                        : t("account.card.oauth.unlinked")}
                    </Text>
                    {oauthStatus?.[provider] ? (
                      <Button
                        color="red"
                        variant="light"
                        onClick={() => {
                          modals.openConfirmModal({
                            title: t("account.modal.unlink.title"),
                            children: (
                              <Text>
                                {t("account.modal.unlink.description")}
                              </Text>
                            ),
                            labels: {
                              confirm: t("account.card.oauth.unlink"),
                              cancel: t("common.button.cancel"),
                            },
                            confirmProps: { color: "red" },
                            onConfirm: () => {
                              unlinkOAuth(provider)
                                .then(() => {
                                  toast.success(
                                    t("account.notify.oauth.unlinked.success"),
                                  );
                                  refreshOAuthStatus();
                                })
                                .catch(toast.axiosError);
                            },
                          });
                        }}
                      >
                        {t("account.card.oauth.unlink")}
                      </Button>
                    ) : (
                      <Button
                        component="a"
                        href={getOAuthUrl(window.location.origin, provider)}
                        color="orange"
                        variant="light"
                      >
                        {t("account.card.oauth.link")}
                      </Button>
                    )}
                  </Group>
                </Tabs.Panel>
              ))}
            </Tabs>
          </Paper>
        )}
        <Paper withBorder p="xl" mt="lg">
          <Title order={5} mb="xs">
            <FormattedMessage id="account.card.security.title" />
          </Title>

          <Tabs defaultValue="totp">
            <Tabs.List>
              <Tabs.Tab value="totp" leftSection={<TbAuth2Fa size={14} />}>
                TOTP
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="totp" pt="xs">
              {user?.totpVerified ? (
                <>
                  <form
                    onSubmit={disableTotpForm.onSubmit((values) => {
                      authService
                        .disableTOTP(values.code, values.password)
                        .then(() => {
                          toast.success(t("account.notify.totp.disable"));
                          values.password = "";
                          values.code = "";
                          refreshUser();
                        })
                        .catch(toast.axiosError);
                    })}
                  >
                    <Stack>
                      <PasswordInput
                        description={t(
                          "account.card.security.totp.disable.description",
                        )}
                        label={t("account.card.password.title")}
                        {...disableTotpForm.getInputProps("password")}
                      />

                      <TextInput
                        variant="filled"
                        label={t("account.modal.totp.codeOrBackup")}
                        placeholder="123456 / A1B2C3D4"
                        {...disableTotpForm.getInputProps("code")}
                      />

                      <Group justify="right">
                        <Button color="red" type="submit">
                          <FormattedMessage id="common.button.disable" />
                        </Button>
                      </Group>
                    </Stack>
                  </form>
                </>
              ) : (
                <>
                  <form
                    onSubmit={enableTotpForm.onSubmit((values) => {
                      authService
                        .enableTOTP(values.password)
                        .then((result) => {
                          showEnableTotpModal(modals, refreshUser, {
                            qrCode: result.qrCode,
                            secret: result.totpSecret,
                            password: values.password,
                          });
                          values.password = "";
                        })
                        .catch(toast.axiosError);
                    })}
                  >
                    <Stack>
                      <PasswordInput
                        label={t("account.card.password.title")}
                        description={t(
                          "account.card.security.totp.enable.description",
                        )}
                        {...enableTotpForm.getInputProps("password")}
                      />
                      <Group justify="right">
                        <Button type="submit">
                          <FormattedMessage id="account.card.security.totp.button.start" />
                        </Button>
                      </Group>
                    </Stack>
                  </form>
                </>
              )}
            </Tabs.Panel>
          </Tabs>
        </Paper>
        <E2EEncryptionSection refreshUser={refreshUser} />
        <PushNotificationSection />
        <Paper withBorder p="xl" mt="lg">
          <Title order={5} mb="xs">
            <FormattedMessage id="account.notify.title" />
          </Title>
          <Text size="sm" c="dimmed" mb="sm">
            <FormattedMessage id="account.notify.description" />
          </Text>
          <Radio.Group
            value={user?.notificationMode ?? "DIGEST"}
            onChange={async (value) => {
              try {
                await userService.updateCurrentUser({ notificationMode: value });
                await refreshUser();
                toast.success(t("common.success"));
              } catch {
                toast.error(t("common.error"));
              }
            }}
          >
            <Stack gap="xs">
              <Radio
                value="INSTANT"
                label={t("account.notify.instant.label")}
                description={t("account.notify.instant.description")}
              />
              <Radio
                value="DIGEST"
                label={t("account.notify.digest.label")}
                description={t("account.notify.digest.description")}
              />
              <Radio
                value="WEEKLY"
                label={t("account.notify.weekly.label")}
                description={t("account.notify.weekly.description")}
              />
            </Stack>
          </Radio.Group>
        </Paper>
        <Paper withBorder p="xl" mt="lg">
          <Title order={5} mb="xs">
            <FormattedMessage id="account.card.language.title" />
          </Title>
          <LanguagePicker />
        </Paper>
        <Paper withBorder p="xl" mt="lg">
          <Title order={5} mb="xs">
            <FormattedMessage id="account.card.color.title" />
          </Title>
          <ThemeSwitcher />
        </Paper>
        {teamStatus?.needsTeamCreation && (
          <Paper withBorder p="xl" mt="lg">
            <Title order={5} mb="xs">
              <Group gap="xs">
                <TbUsersGroup size={18} />
                <FormattedMessage id="account.team.title" />
              </Group>
            </Title>
            <Text size="sm" c="dimmed" mb="md">
              <FormattedMessage id="account.team.description" />
            </Text>
            <Button
              leftSection={<TbUsersGroup size={16} />}
              onClick={() => setShowCreateTeam(true)}
            >
              <FormattedMessage id="account.team.create-button" />
            </Button>
          </Paper>
        )}
        <CreateTeamModal
          opened={showCreateTeam}
          onClose={() => setShowCreateTeam(false)}
        />
        <Center mt={80} mb="lg">
          <Stack>
            <Button
              variant="light"
              color="red"
              loading={isDeleting}
              onClick={() =>
                modals.openConfirmModal({
                  title: t("account.modal.delete.title"),
                  children: (
                    <Text size="sm">
                      <FormattedMessage id="account.modal.delete.description" />
                    </Text>
                  ),

                  labels: {
                    confirm: t("common.button.delete"),
                    cancel: t("common.button.cancel"),
                  },
                  confirmProps: { color: "red" },
                  onConfirm: async () => {
                    setIsDeleting(true);
                    await userService
                      .removeCurrentUser()
                      .then(() => {
                        removeUserKey();
                        window.location.reload();
                      })
                      .catch((e) => {
                        toast.axiosError(e);
                        setIsDeleting(false);
                      });
                  },
                })
              }
            >
              <FormattedMessage id="account.button.delete" />
            </Button>
          </Stack>
        </Center>
      </Container>
    </>
  );
};

export default Account;
