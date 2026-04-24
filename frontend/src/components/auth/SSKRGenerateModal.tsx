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
import { TbCopy, TbCheck, TbShieldCheck } from "react-icons/tb";
import { splitKey } from "../../utils/sskr.util";

interface SSKRGenerateModalProps {
  opened: boolean;
  onClose: () => void;
  encodedKey: string;
}

const SSKRGenerateModal = ({
  opened,
  onClose,
  encodedKey,
}: SSKRGenerateModalProps) => {
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
        <Group spacing="xs">
          <TbShieldCheck size={20} />
          <Text weight={600}>SSKR recovery fragments</Text>
        </Group>
      }
      centered
      closeOnClickOutside={false}
      size="lg"
    >
      {/* Step 0 : configuration */}
      {step === 0 && (
        <Stack spacing="md">
          <Text size="sm" color="dimmed">
            Your encryption key will be split into <strong>N fragments</strong>.
            You will need at least <strong>T</strong> of them to reconstruct it.
            With T-1 fragments or fewer, it is mathematically impossible to
            recover the key.
          </Text>
          <Text size="sm" color="dimmed">
            Store each fragment in a different location: password manager,
            USB drive, paper safe, trusted contact...
          </Text>

          <NumberInput
            label="Minimum threshold (T)"
            description="Number of fragments required to reconstruct the key"
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
            label="Total fragments (N)"
            description="Number of fragments to generate"
            value={total}
            onChange={(v) => setTotal(typeof v === "number" ? v : 5)}
            min={threshold}
            max={10}
          />

          <Group position="right" mt="xs">
            <Button variant="subtle" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={handleGenerate}>
              Generate {total} fragments
            </Button>
          </Group>
        </Stack>
      )}

      {/* Steps 1..N : show each shard */}
      {isShowingShard && shards[shardIndex] && (
        <Stack spacing="md">
          <Text size="sm" weight={500}>
            Fragment {shardIndex + 1} of {total}
          </Text>
          <Text size="xs" color="dimmed">
            Copy this fragment and store it in a safe place. Only share
            it with people you trust.
          </Text>

          <Group spacing="xs" noWrap>
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
                <Tooltip label={copied ? "Copied!" : "Copy"}>
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
            label="I have saved this fragment in a safe place"
            checked={acknowledged[shardIndex] ?? false}
            onChange={(e) => {
              const next = [...acknowledged];
              next[shardIndex] = e.currentTarget.checked;
              setAcknowledged(next);
            }}
          />

          <Group position="right" mt="xs">
            {step > 1 && (
              <Button variant="subtle" onClick={() => setStep(step - 1)}>
                Previous
              </Button>
            )}
            <Button
              disabled={!acknowledged[shardIndex]}
              onClick={() => setStep(step + 1)}
            >
              {step < total ? "Next" : "Finish"}
            </Button>
          </Group>
        </Stack>
      )}

      {/* Final step */}
      {isDone && (
        <Stack spacing="md" align="center">
          <TbShieldCheck size={48} color="teal" />
          <Text size="sm" ta="center">
            Your <strong>{total} fragments</strong> have been created.
            You will need <strong>{threshold}</strong> of them to reconstruct
            your key. Store them separately!
          </Text>
          <Button onClick={handleClose}>Close</Button>
        </Stack>
      )}
    </Modal>
  );
};

export default SSKRGenerateModal;
