import { ActionIcon, Group, Progress, Text, Tooltip } from "@mantine/core";
import { TbX } from "react-icons/tb";
import useTranslate from "../../hooks/useTranslate.hook";

const DownloadProgressIndicator = ({
  progress,
  onCancel,
}: {
  progress: number;
  onCancel?: () => void;
}) => {
  const t = useTranslate();

  // La jauge se "vide" de droite à gauche : la partie colorée représente
  // ce qu'il reste à télécharger. Quand le download atteint 100 %,
  // la barre est vide (0 %). C'est l'inverse visuel de l'upload.
  const remaining = Math.max(0, 100 - progress);

  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 100 }}>
      <Progress
        value={remaining}
        color="blue"
        size="sm"
        transitionDuration={300}
        style={{ flex: 1, minWidth: 50 }}
      />
      <Text
        size="xs"
        c="dimmed"
        style={{ minWidth: 32, textAlign: "right", whiteSpace: "nowrap" }}
      >
        {Math.round(progress)}%
      </Text>
      {onCancel && (
        <Tooltip label={t("share.download.cancel")}>
          <ActionIcon
            size={20}
            variant="subtle"
            color="red"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            <TbX size={14} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
};

export default DownloadProgressIndicator;
