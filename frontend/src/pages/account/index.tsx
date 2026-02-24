import {
  Badge,
  Button,
  Center,
  Code,
  Container,
  CopyButton,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useForm, yupResolver } from "@mantine/form";
import { useModals } from "@mantine/modals";
import { useEffect, useState } from "react";
import { TbAuth2Fa, TbCopy, TbCheck, TbEye, TbEyeOff, TbKey, TbShieldLock } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import * as yup from "yup";
import Meta from "../../components/Meta";
import LanguagePicker from "../../components/account/LanguagePicker";
import ThemeSwitcher from "../../components/account/ThemeSwitcher";
import showEnableTotpModal from "../../components/account/showEnableTotpModal";
import useTranslate from "../../hooks/useTranslate.hook";
import useUser from "../../hooks/user.hook";
import authService from "../../services/auth.service";
import userService from "../../services/user.service";
import { getOAuthIcon, getOAuthUrl, unlinkOAuth } from "../../utils/oauth.util";
import toast from "../../utils/toast.util";
import {
  generateEncryptionKey,
  exportKeyToBase64,
  importKeyFromBase64,
  computeKeyHash,
  computeKeyHashFromEncoded,
  getUserKey,
  storeUserKey,
  removeUserKey,
} from "../../utils/crypto.util";

// ─── E2E Encryption Section ───────────────────────────────────────────
const E2EEncryptionSection = ({
  refreshUser,
}: {
  refreshUser: () => void;
}) => {
  const t = useTranslate();
  const modals = useModals();
  const { user } = useUser();

  const [localKey, setLocalKey] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Sync localStorage key into component state
  useEffect(() => {
    setLocalKey(getUserKey());
  }, []);

  const hasServerKey = !!user?.hasEncryptionKey;
  const hasLocalKey = !!localKey;

  // ── Generate a new key ──────────────────────────────────────────
  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const key = await generateEncryptionKey();
      const encoded = await exportKeyToBase64(key);
      const hash = await computeKeyHash(key);
      await userService.setEncryptionKeyHash(hash);
      storeUserKey(encoded);
      setLocalKey(encoded);
      refreshUser();
      toast.success("Clé E2E générée avec succès");
    } catch (e: any) {
      toast.error(e?.message ?? "Erreur lors de la génération de la clé");
    } finally {
      setGenerating(false);
    }
  };

  // ── Confirm-then-generate (warns about losing access to old shares)
  const confirmRegenerate = () => {
    modals.openConfirmModal({
      title: "Régénérer la clé de chiffrement",
      children: (
        <Text size="sm">
          Tous les partages E2E existants chiffrés avec l'ancienne clé
          deviendront <strong>inaccessibles</strong>. Cette action est
          irréversible. Êtes-vous sûr ?
        </Text>
      ),
      labels: { confirm: "Régénérer", cancel: "Annuler" },
      confirmProps: { color: "red" },
      onConfirm: handleGenerate,
    });
  };

  // ── Import an existing key (for new browser / device) ───────────
  const handleImport = async () => {
    setImportError("");
    if (!importValue.trim()) {
      setImportError("Veuillez entrer votre clé E2E");
      return;
    }
    setImporting(true);
    try {
      // Validate the key format by trying to import it
      await importKeyFromBase64(importValue.trim());
      // Compute hash and verify against server
      const hash = await computeKeyHashFromEncoded(importValue.trim());
      const valid = await userService.verifyEncryptionKey(hash);
      if (!valid) {
        setImportError(
          "Cette clé ne correspond pas à celle enregistrée sur le serveur",
        );
        return;
      }
      storeUserKey(importValue.trim());
      setLocalKey(importValue.trim());
      setImportValue("");
      toast.success("Clé E2E importée avec succès");
    } catch (e: any) {
      setImportError(e?.message ?? "Clé invalide");
    } finally {
      setImporting(false);
    }
  };

  // ── Revoke key ──────────────────────────────────────────────────
  const handleRevoke = () => {
    modals.openConfirmModal({
      title: "Supprimer la clé de chiffrement",
      children: (
        <Text size="sm">
          Tous les partages E2E existants deviendront{" "}
          <strong>définitivement inaccessibles</strong>. Cette action est
          irréversible.
        </Text>
      ),
      labels: { confirm: "Supprimer", cancel: "Annuler" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await userService.removeEncryptionKey();
          removeUserKey();
          setLocalKey(null);
          refreshUser();
          toast.success("Clé E2E supprimée");
        } catch (e: any) {
          toast.error(e?.message ?? "Erreur lors de la suppression");
        }
      },
    });
  };

  // Masked display of the key
  const maskedKey = localKey
    ? localKey.slice(0, 8) + "••••••••••••" + localKey.slice(-8)
    : null;

  return (
    <Paper withBorder p="xl" mt="lg">
      <Group mb="xs" spacing="xs">
        <TbShieldLock size={20} />
        <Title order={5}>Chiffrement de bout en bout (E2E)</Title>
      </Group>

      <Text size="sm" color="dimmed" mb="md">
        Votre clé de chiffrement AES-256 est stockée uniquement dans votre
        navigateur. Elle n'est jamais envoyée au serveur. Conservez-la
        précieusement pour pouvoir déchiffrer vos partages.
      </Text>

      {/* ── Key exists locally ─────────────────────────────────── */}
      {hasLocalKey && localKey && (
        <Stack spacing="xs">
          <Group spacing="xs">
            <TbKey size={16} />
            <Text size="sm" weight={500}>
              Votre clé :
            </Text>
          </Group>
          <Group spacing="xs">
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
            <Tooltip label={revealKey ? "Masquer" : "Révéler"}>
              <Button
                variant="subtle"
                size="xs"
                px={6}
                onClick={() => setRevealKey((v) => !v)}
              >
                {revealKey ? <TbEyeOff size={16} /> : <TbEye size={16} />}
              </Button>
            </Tooltip>
            <CopyButton value={localKey}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? "Copié !" : "Copier la clé"}>
                  <Button variant="subtle" size="xs" px={6} onClick={copy}>
                    {copied ? (
                      <TbCheck size={16} color="teal" />
                    ) : (
                      <TbCopy size={16} />
                    )}
                  </Button>
                </Tooltip>
              )}
            </CopyButton>
          </Group>

          <Group position="right" mt="sm">
            <Button
              variant="light"
              color="orange"
              size="xs"
              onClick={confirmRegenerate}
              loading={generating}
            >
              Régénérer la clé
            </Button>
            <Button
              variant="light"
              color="red"
              size="xs"
              onClick={handleRevoke}
            >
              Supprimer la clé
            </Button>
          </Group>
        </Stack>
      )}

      {/* ── Server has key hash but nothing locally (new device) ── */}
      {hasServerKey && !hasLocalKey && (
        <Stack spacing="xs">
          <Text size="sm" color="yellow">
            ⚠ Une clé E2E est enregistrée sur votre compte mais absente de ce
            navigateur. Importez-la pour accéder à vos partages chiffrés.
          </Text>
          <Group align="flex-end" spacing="xs">
            <TextInput
              style={{ flex: 1 }}
              label="Importer votre clé"
              placeholder="Collez votre clé E2E ici…"
              value={importValue}
              onChange={(e) => {
                setImportValue(e.currentTarget.value);
                setImportError("");
              }}
              error={importError}
            />
            <Button onClick={handleImport} loading={importing} size="sm">
              Vérifier & importer
            </Button>
          </Group>
          <Group position="right" mt="xs">
            <Button
              variant="light"
              color="red"
              size="xs"
              onClick={handleRevoke}
            >
              Supprimer l'ancienne clé et en créer une nouvelle
            </Button>
          </Group>
        </Stack>
      )}

      {/* ── No key at all ─────────────────────────────────────── */}
      {!hasServerKey && !hasLocalKey && (
        <Stack spacing="xs">
          <Text size="sm">
            Aucune clé E2E configurée. Générez une clé pour activer le
            chiffrement de bout en bout sur vos futurs partages.
          </Text>
          <Group position="right">
            <Button
              leftIcon={<TbKey size={16} />}
              onClick={handleGenerate}
              loading={generating}
            >
              Générer une clé E2E
            </Button>
          </Group>
        </Stack>
      )}
    </Paper>
  );
};

// ─── Main Account page ────────────────────────────────────────────────
const Account = () => {
  const [oauth, setOAuth] = useState<string[]>([]);
  const [oauthStatus, setOAuthStatus] = useState<Record<
    string,
    {
      provider: string;
      providerUsername: string;
    }
  > | null>(null);

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
          .min(6, t("common.error.exact-length", { length: 6 }))
          .max(6, t("common.error.exact-length", { length: 6 }))
          .matches(/^[0-9]+$/, { message: t("common.error.invalid-number") }),
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
      <Container size="sm">
        <Title order={3} mb="xs">
          <FormattedMessage id="account.title" />
        </Title>
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
                <Group position="right">
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
                  <Text size="sm" color="dimmed">
                    <FormattedMessage id="account.card.password.noPasswordSet" />
                  </Text>
                )}
                <PasswordInput
                  label={t("account.card.password.new")}
                  {...passwordForm.getInputProps("password")}
                />
                <Group position="right">
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
                    icon={getOAuthIcon(provider)}
                    key={provider}
                  >
                    {t(`account.card.oauth.${provider}`)}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
              {oauth.map((provider) => (
                <Tabs.Panel value={provider} pt="xs" key={provider}>
                  <Group position="apart">
                    <Text>
                      {oauthStatus?.[provider]
                        ? oauthStatus[provider].providerUsername
                        : t("account.card.oauth.unlinked")}
                    </Text>
                    {oauthStatus?.[provider] ? (
                      <Button
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
              <Tabs.Tab value="totp" icon={<TbAuth2Fa size={14} />}>
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
                        label={t("account.modal.totp.code")}
                        placeholder="******"
                        {...disableTotpForm.getInputProps("code")}
                      />

                      <Group position="right">
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
                      <Group position="right">
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
        <Center mt={80} mb="lg">
          <Stack>
            <Button
              variant="light"
              color="red"
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
                    await userService
                      .removeCurrentUser()
                      .then(() => window.location.reload())
                      .catch(toast.axiosError);
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
