import {
  Button,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Modal,
  NumberInput,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { TbCopy, TbCheck, TbShieldCheck } from "react-icons/tb";
import { splitKey } from "../../utils/sskr.util";

interface SSKRGenerateModalProps {
  opened: boolean;
  onClose: () => void;
  onComplete?: () => void;
  encodedKey: string;
}

const SSKRGenerateModal = ({
  opened,
  onClose,
  onComplete,
  encodedKey,
}: SSKRGenerateModalProps) => {
  const intl = useIntl();
  const [step, setStep] = useState(0);
  const [threshold, setThreshold] = useState(3);
  const [total, setTotal] = useState(5);
  const [shards, setShards] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState<boolean[]>([]);

  const reset = () => {
    setStep(0);
    setShards([]);
    setAcknowledged([]);
    setThreshold(3);
    setTotal(5);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleGenerate = () => {
    const result = splitKey(encodedKey, threshold, total);
    setShards(result);
    setAcknowledged(new Array(result.length).fill(false));
    setStep(1);
  };

  const shardIndex = step - 1;
  const isShowingShard = step >= 1 && step <= total;
  const isDone = step > total;

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={
        <Group gap="xs">
          <TbShieldCheck size={20} />
          <Text fw={600}>Fragments de récupération SSKR</Text>
        </Group>
      }
      centered
      closeOnClickOutside={false}
      size="lg"
    >
      {/* Step 0 : configuration */}
      {step === 0 && (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            <FormattedMessage
              id="sskr.intro"
              values={{ strong: (chunks) => <strong>{chunks}</strong> }}
            />
          </Text>
          <Text size="sm" c="dimmed">
            <FormattedMessage id="sskr.storage" />
          </Text>

          <NumberInput
            label={intl.formatMessage({ id: "sskr.threshold.label" })}
            description={intl.formatMessage({
              id: "sskr.threshold.description",
            })}
            value={threshold}
            onChange={(v) => {
              const val = typeof v === "number" ? v : 3;
              setThreshold(val);
              if (total < val) setTotal(val);
            }}
            min={2}
            max={10}
          />
          <NumberInput
            label={intl.formatMessage({ id: "sskr.total.label" })}
            description={intl.formatMessage({ id: "sskr.total.description" })}
            value={total}
            onChange={(v) => setTotal(typeof v === "number" ? v : 5)}
            min={threshold}
            max={10}
          />

          <Group justify="right" mt="xs">
            <Button variant="subtle" onClick={handleClose}>
              <FormattedMessage id="sskr.cancel" />
            </Button>
            <Button onClick={handleGenerate}>
              <FormattedMessage id="sskr.generate" values={{ total }} />
            </Button>
          </Group>
        </Stack>
      )}

      {/* Steps 1..N : show each shard */}
      {isShowingShard && shards[shardIndex] && (
        <Stack gap="md">
          <Text size="sm" fw={500}>
            <FormattedMessage
              id="sskr.shard.title"
              values={{ n: shardIndex + 1, total }}
            />
          </Text>
          <Text size="xs" c="dimmed">
            <FormattedMessage id="sskr.shard.instructions" />
          </Text>

          <Group gap="xs" wrap="nowrap">
            <Code
              block
              style={{
                flex: 1,
                wordBreak: "break-all",
                fontSize: "0.72rem",
                userSelect: "all",
              }}
            >
              {shards[shardIndex]}
            </Code>
            <CopyButton value={shards[shardIndex]}>
              {({ copied, copy }) => (
                <Tooltip
                  label={intl.formatMessage({
                    id: copied ? "sskr.copied" : "sskr.copy",
                  })}
                >
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

          <Checkbox
            label={intl.formatMessage({ id: "sskr.shard.acknowledge" })}
            checked={acknowledged[shardIndex] ?? false}
            onChange={(e) => {
              const next = [...acknowledged];
              next[shardIndex] = e.currentTarget.checked;
              setAcknowledged(next);
            }}
          />

          <Group justify="right" mt="xs">
            {step > 1 && (
              <Button variant="subtle" onClick={() => setStep(step - 1)}>
                <FormattedMessage id="sskr.previous" />
              </Button>
            )}
            <Button
              disabled={!acknowledged[shardIndex]}
              onClick={() => {
                if (step === total) onComplete?.();
                setStep(step + 1);
              }}
            >
              <FormattedMessage
                id={step < total ? "sskr.next" : "sskr.finish"}
              />
            </Button>
          </Group>
        </Stack>
      )}

      {/* Final step */}
      {isDone && (
        <Stack gap="md" align="center">
          <TbShieldCheck size={48} color="teal" />
          <Text size="sm" ta="center">
            <FormattedMessage
              id="sskr.done"
              values={{
                total,
                threshold,
                strong: (chunks) => <strong>{chunks}</strong>,
              }}
            />
          </Text>
          <Button onClick={handleClose}>
            <FormattedMessage id="sskr.close" />
          </Button>
        </Stack>
      )}
    </Modal>
  );
};

export default SSKRGenerateModal;
