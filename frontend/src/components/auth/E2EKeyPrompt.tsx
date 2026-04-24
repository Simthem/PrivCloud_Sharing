import {
  Button,
  Code,
  CopyButton,
  Divider,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Stack,
  Text,
} from "@mantine/core";
import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { TbCopy, TbCheck, TbShieldLock } from "react-icons/tb";
import {
  importKeyFromBase64,
  computeKeyHashFromEncoded,
  computeKeyHashFromEncodedLegacy,
  storeUserKey,
} from "../../utils/crypto.util";
import { combineShards } from "../../utils/sskr.util";
import userService from "../../services/user.service";
import toast from "../../utils/toast.util";

interface E2EKeyPromptProps {
  opened: boolean;
  onClose: () => void;
  userId: string;
}

const E2EKeyPrompt = ({ opened, onClose, userId }: E2EKeyPromptProps) => {
  const intl = useIntl();
  const [mode, setMode] = useState<"import" | "recover" | "recovered">("import");

  // -- import mode --
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // -- recover mode --
  const [shardCount, setShardCount] = useState(3);
  const [shardValues, setShardValues] = useState<string[]>(["", "", ""]);
  const [recoverError, setRecoverError] = useState("");
  const [recovering, setRecovering] = useState(false);

  // -- recovered mode (show key after SSKR success) --
  const [recoveredKey, setRecoveredKey] = useState("");

  const resetAll = () => {
    setValue("");
    setError("");
    setLoading(false);
    setMode("import");
    setShardCount(3);
    setShardValues(["", "", ""]);
    setRecoverError("");
    setRecovering(false);
    setRecoveredKey("");
  };

  /** Verifies an encodedKey (HMAC then legacy), stores and migrates if needed. */
  const verifyAndStore = async (encodedKey: string) => {
    await importKeyFromBase64(encodedKey);
    const hash = await computeKeyHashFromEncoded(encodedKey, userId);
    let valid = await userService.verifyEncryptionKey(hash);
    if (!valid) {
      const legacyHash = await computeKeyHashFromEncodedLegacy(encodedKey);
      valid = await userService.verifyEncryptionKey(legacyHash);
      if (!valid) return false;
      await userService.setEncryptionKeyHash(hash);
    }
    storeUserKey(encodedKey);
    return true;
  };

  const handleImport = async () => {
    setError("");
    const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "");
    if (!sanitized) {
      setError("Please enter your encryption key.");
      return;
    }
    setLoading(true);
    try {
      const ok = await verifyAndStore(sanitized);
      if (!ok) {
        setError(
          "This key does not match the one registered on your account.",
        );
        return;
      }
      toast.success("Key loaded for this session.");
      resetAll();
      onClose();
    } catch {
      setError("Invalid key.");
    } finally {
      setLoading(false);
    }
  };

  const handleRecover = async () => {
    setRecoverError("");
    const filled = shardValues.filter((s) => s.trim().length > 0);
    if (filled.length < 2) {
      setRecoverError("Enter at least 2 fragments.");
      return;
    }
    setRecovering(true);
    try {
      const encodedKey = combineShards(filled);
      const ok = await verifyAndStore(encodedKey);
      if (!ok) {
        setRecoverError(
          "The reconstructed key does not match the one on your account. " +
            "Please verify that the fragments are correct.",
        );
        return;
      }
      setRecoveredKey(encodedKey);
      setMode("recovered");
      toast.success("Key reconstructed and loaded for this session.");
    } catch (e: any) {
      setRecoverError(e?.message ?? "Unable to reconstruct the key.");
    } finally {
      setRecovering(false);
    }
  };

  const handleSkip = () => {
    resetAll();
    onClose();
  };

  const handleCloseRecovered = () => {
    resetAll();
    onClose();
  };

  const updateShardCount = (v: number | "") => {
    const n = typeof v === "number" ? Math.max(2, Math.min(10, v)) : 3;
    setShardCount(n);
    setShardValues((prev) => {
      const next = [...prev];
      while (next.length < n) next.push("");
      return next.slice(0, n);
    });
  };

  return (
    <Modal
      opened={opened}
      onClose={handleSkip}
      title={
        <Group spacing="xs">
          <TbShieldLock size={20} />
          <Text weight={600}>
            <FormattedMessage id="e2ePrompt.title" />
          </Text>
        </Group>
      }
      centered
      closeOnClickOutside={false}
      size={mode === "recover" ? "lg" : "md"}
    >
      {mode === "recovered" && (
        <Stack spacing="sm">
          <Text size="sm" color="teal" weight={600}>
            <FormattedMessage id="e2ePrompt.recovered.success" />
          </Text>
          <Text size="sm" color="dimmed">
            <FormattedMessage id="e2ePrompt.recovered.instructions" />
          </Text>
          <Code
            block
            style={{ wordBreak: "break-all", fontSize: "0.75rem", userSelect: "all" }}
            aria-label={intl.formatMessage({ id: "e2ePrompt.recovered.key.aria" })}
          >
            {recoveredKey}
          </Code>
          <Group position="right" spacing="xs">
            <CopyButton value={recoveredKey} timeout={3000}>
              {({ copied, copy }) => (
                <Button
                  variant="light"
                  size="xs"
                  leftIcon={copied ? <TbCheck size={14} /> : <TbCopy size={14} />}
                  onClick={copy}
                  aria-label={intl.formatMessage({ id: "e2ePrompt.recovered.copy.aria" })}
                >
                  {copied
                    ? intl.formatMessage({ id: "e2ePrompt.recovered.copied" })
                    : intl.formatMessage({ id: "e2ePrompt.recovered.copy" })}
                </Button>
              )}
            </CopyButton>
            <Button onClick={handleCloseRecovered}>
              <FormattedMessage id="common.button.close" />
            </Button>
          </Group>
        </Stack>
      )}

      {mode === "import" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleImport();
          }}
        >
          <Stack spacing="sm">
            <Text size="sm" color="dimmed">
              <FormattedMessage id="e2ePrompt.import.description" />
            </Text>
            <PasswordInput
              label={intl.formatMessage({ id: "e2ePrompt.import.label" })}
              placeholder={intl.formatMessage({ id: "e2ePrompt.import.placeholder" })}
              value={value}
              onChange={(e) => {
                setValue(e.currentTarget.value);
                setError("");
              }}
              error={error}
              autoFocus
              aria-label={intl.formatMessage({ id: "e2ePrompt.import.label" })}
            />
            <div role="alert" aria-live="assertive">
              {error && <Text size="xs" color="red">{error}</Text>}
            </div>
            <Group position="right" mt="xs">
              <Button
                variant="subtle"
                onClick={handleSkip}
                disabled={loading}
              >
                <FormattedMessage id="e2ePrompt.import.skip" />
              </Button>
              <Button type="submit" loading={loading}>
                <FormattedMessage id="e2ePrompt.import.submit" />
              </Button>
            </Group>

            <Divider label={intl.formatMessage({ id: "e2ePrompt.divider.or" })} labelPosition="center" />

            <Button
              variant="subtle"
              compact
              onClick={() => setMode("recover")}
            >
              <FormattedMessage id="e2ePrompt.import.sskrLink" />
            </Button>

            <Text size="xs" color="dimmed">
              <FormattedMessage id="e2ePrompt.import.skipWarning" />
            </Text>
          </Stack>
        </form>
      )}

      {mode === "recover" && (
        <Stack spacing="sm">
          <Text size="sm" color="dimmed">
            <FormattedMessage id="e2ePrompt.recover.description" />
          </Text>

          <NumberInput
            label={intl.formatMessage({ id: "e2ePrompt.recover.shardCount" })}
            value={shardCount}
            onChange={updateShardCount}
            min={2}
            max={10}
            size="sm"
            aria-label={intl.formatMessage({ id: "e2ePrompt.recover.shardCount" })}
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
              aria-label={intl.formatMessage({ id: "e2ePrompt.recover.shard" }, { n: i + 1 })}
            />
          ))}

          <div role="alert" aria-live="assertive">
            {recoverError && (
              <Text size="xs" color="red">
                {recoverError}
              </Text>
            )}
          </div>

          <Group position="right" mt="xs">
            <Button variant="subtle" onClick={() => setMode("import")}>
              <FormattedMessage id="e2ePrompt.recover.back" />
            </Button>
            <Button onClick={handleRecover} loading={recovering}>
              <FormattedMessage id="e2ePrompt.recover.submit" />
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
};

export default E2EKeyPrompt;
