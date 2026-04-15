import { Modal, Progress, Stack, Text, Group, Button, Alert, List } from "@mantine/core";
import { TbAlertTriangle, TbCheck, TbLock, TbRefresh, TbX } from "react-icons/tb";
import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { reencryptAll, ReencryptProgress, ReencryptResult } from "../../utils/reencrypt.util";

interface Props {
  opened: boolean;
  oldKey: string;
  newKey: string;
  onSuccess: () => void;
  onError: (err: string) => void;
}

const ReencryptModal = ({ opened, oldKey, newKey, onSuccess, onError }: Props) => {
  const intl = useIntl();
  const [progress, setProgress] = useState<ReencryptProgress | null>(null);
  const [result, setResult] = useState<ReencryptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const running = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setError(null);
    setDone(false);
    setResult(null);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await reencryptAll(oldKey, newKey, setProgress, ac.signal);
      setResult(res);
      setDone(true);
      if (res.filesFailed === 0 && res.reverseSharesFailed === 0) {
        onSuccess();
      } else {
        onError(
          intl.formatMessage(
            { id: "reencrypt.error.partial" },
            { failed: res.filesFailed, rsFailed: res.reverseSharesFailed },
          ),
        );
      }
    } catch (e: any) {
      const msg = e?.message ?? intl.formatMessage({ id: "reencrypt.error.generic" });
      setError(msg);
      onError(msg);
    } finally {
      running.current = false;
      abortRef.current = null;
    }
  }, [oldKey, newKey, onSuccess, onError, intl]);

  useEffect(() => {
    if (opened && oldKey && newKey) {
      run();
    }
  }, [opened, oldKey, newKey, run]);

  // Prevent closing the tab while re-encryption is running
  useEffect(() => {
    if (!opened) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (running.current) {
        e.preventDefault();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [opened]);

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleRetry = () => {
    run();
  };

  const totalItems = (progress?.filesTotal ?? 0) + (progress?.reverseSharesTotal ?? 0);
  const doneItems = (progress?.filesDone ?? 0) + (progress?.reverseSharesDone ?? 0);
  const pct = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;

  const hasPartialFailures = result && (result.filesFailed > 0 || result.reverseSharesFailed > 0);

  return (
    <Modal
      opened={opened}
      onClose={() => {}}
      closeOnClickOutside={false}
      closeOnEscape={false}
      withCloseButton={false}
      title={
        <Group spacing="xs">
          <TbLock size={18} />
          <Text weight={600}>
            <FormattedMessage id="reencrypt.modal.title" />
          </Text>
        </Group>
      }
    >
      <Stack spacing="md">
        <div role="status" aria-live="polite" aria-atomic="true">
          {error ? (
            <Alert
              icon={<TbAlertTriangle size={18} />}
              title={intl.formatMessage({ id: "reencrypt.error.title" })}
              color="red"
            >
              {error}
            </Alert>
          ) : done && !hasPartialFailures ? (
            <Alert icon={<TbCheck size={18} />} title={intl.formatMessage({ id: "reencrypt.done.title" })} color="green">
              <FormattedMessage
                id="reencrypt.done.message"
                values={{ count: result?.filesReencrypted ?? 0, skipped: result?.filesSkipped ?? 0 }}
              />
            </Alert>
          ) : done && hasPartialFailures ? (
            <Alert icon={<TbAlertTriangle size={18} />} title={intl.formatMessage({ id: "reencrypt.partial.title" })} color="orange">
              <FormattedMessage
                id="reencrypt.partial.message"
                values={{
                  ok: result?.filesReencrypted ?? 0,
                  failed: result?.filesFailed ?? 0,
                  skipped: result?.filesSkipped ?? 0,
                }}
              />
              {result?.failedDetails && result.failedDetails.length > 0 && (
                <List size="xs" mt="xs">
                  {result.failedDetails.map((d, i) => (
                    <List.Item key={i}>{d}</List.Item>
                  ))}
                </List>
              )}
            </Alert>
          ) : (
            <>
              <Text size="sm" color="dimmed">
                <FormattedMessage id="reencrypt.inprogress.message" />
              </Text>

              <Text size="xs" weight={600} color="red" mt="xs">
                <FormattedMessage id="reencrypt.inprogress.warning" />
              </Text>

              <Progress
                value={pct}
                animate={!done}
                size="lg"
                mt="sm"
                label={totalItems > 0 ? `${pct}%` : undefined}
                aria-label={intl.formatMessage({ id: "reencrypt.progress.label" })}
              />

              {progress?.phase === "files" && (
                <Text size="xs" color="dimmed" mt="xs">
                  <FormattedMessage
                    id="reencrypt.progress.files"
                    values={{
                      current: Math.min((progress.filesDone ?? 0) + 1, progress.filesTotal),
                      total: progress.filesTotal,
                      name: progress.currentFile ?? "",
                    }}
                  />
                </Text>
              )}

              {progress?.phase === "reverseShares" && (
                <Text size="xs" color="dimmed" mt="xs">
                  <FormattedMessage
                    id="reencrypt.progress.reverseShares"
                    values={{
                      current: Math.min((progress.reverseSharesDone ?? 0) + 1, progress.reverseSharesTotal),
                      total: progress.reverseSharesTotal,
                    }}
                  />
                </Text>
              )}
            </>
          )}
        </div>

        {/* Buttons */}
        {!done && !error && (
          <Group position="right">
            <Button
              variant="subtle"
              color="red"
              size="xs"
              leftIcon={<TbX size={14} />}
              onClick={handleCancel}
            >
              <FormattedMessage id="reencrypt.button.cancel" />
            </Button>
          </Group>
        )}

        {done && !hasPartialFailures && (
          <Group position="right">
            <Button
              variant="light"
              color="green"
              onClick={() => onSuccess()}
            >
              <FormattedMessage id="reencrypt.button.close" />
            </Button>
          </Group>
        )}

        {done && hasPartialFailures && (
          <Group position="right">
            <Button
              variant="light"
              color="orange"
              onClick={() => onError(error ?? "")}
            >
              <FormattedMessage id="reencrypt.button.close" />
            </Button>
          </Group>
        )}

        {error && (
          <Group position="right" spacing="xs">
            <Button
              variant="light"
              color="blue"
              leftIcon={<TbRefresh size={14} />}
              onClick={handleRetry}
            >
              <FormattedMessage id="reencrypt.button.retry" />
            </Button>
            <Button
              variant="light"
              color="red"
              onClick={() => onError(error ?? "")}
            >
              <FormattedMessage id="reencrypt.button.close" />
            </Button>
          </Group>
        )}
      </Stack>
    </Modal>
  );
};

export default ReencryptModal;
