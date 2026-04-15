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
          <Text weight={600}>Fragments de récupération SSKR</Text>
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
            Votre clé de chiffrement sera découpée en <strong>N fragments</strong>.
            Il vous en faudra au minimum <strong>T</strong> pour la reconstituer.
            Avec T-1 fragments ou moins, il est mathématiquement impossible de
            retrouver la clé.
          </Text>
          <Text size="sm" color="dimmed">
            Stockez chaque fragment dans un endroit différent : gestionnaire
            de mots de passe, clé USB, coffre-fort papier, contact de confiance…
          </Text>

          <NumberInput
            label="Seuil minimum (T)"
            description="Nombre de fragments nécessaires pour reconstituer la clé"
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
            label="Total de fragments (N)"
            description="Nombre de fragments à générer"
            value={total}
            onChange={(v) => setTotal(typeof v === "number" ? v : 5)}
            min={threshold}
            max={10}
          />

          <Group position="right" mt="xs">
            <Button variant="subtle" onClick={handleClose}>
              Annuler
            </Button>
            <Button onClick={handleGenerate}>
              Générer {total} fragments
            </Button>
          </Group>
        </Stack>
      )}

      {/* Steps 1..N : show each shard */}
      {isShowingShard && shards[shardIndex] && (
        <Stack spacing="md">
          <Text size="sm" weight={500}>
            Fragment {shardIndex + 1} sur {total}
          </Text>
          <Text size="xs" color="dimmed">
            Copiez ce fragment et stockez-le en lieu sûr. Ne le partagez
            qu'avec des personnes en qui vous avez confiance.
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
                <Tooltip label={copied ? "Copié !" : "Copier"}>
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
            label="J'ai sauvegardé ce fragment en lieu sûr"
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
                Précédent
              </Button>
            )}
            <Button
              disabled={!acknowledged[shardIndex]}
              onClick={() => setStep(step + 1)}
            >
              {step < total ? "Suivant" : "Terminer"}
            </Button>
          </Group>
        </Stack>
      )}

      {/* Final step */}
      {isDone && (
        <Stack spacing="md" align="center">
          <TbShieldCheck size={48} color="teal" />
          <Text size="sm" ta="center">
            Vos <strong>{total} fragments</strong> ont été créés.
            Il vous en faudra <strong>{threshold}</strong> pour reconstituer
            votre clé. Conservez-les séparément !
          </Text>
          <Button onClick={handleClose}>Fermer</Button>
        </Stack>
      )}
    </Modal>
  );
};

export default SSKRGenerateModal;
