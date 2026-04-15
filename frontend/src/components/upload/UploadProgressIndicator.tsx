import { Group, Loader, RingProgress, Text, useMantineTheme } from "@mantine/core";
import { TbCircleCheck } from "react-icons/tb";
const UploadProgressIndicator = ({ progress }: { progress: number }) => {
  const theme = useMantineTheme();
  if (progress > 0 && progress < 100) {
    return (
      <Group spacing={6} noWrap>
        <RingProgress
          sections={[{ value: progress, color: theme.primaryColor }]}
          thickness={3}
          size={25}
        />
        <Text size="xs" color="dimmed" sx={{ minWidth: 36, textAlign: "right" }}>
          {Math.round(progress)}%
        </Text>
      </Group>
    );
  } else if (progress >= 100) {
    return (
      <Group spacing={6} noWrap>
        <TbCircleCheck color="green" size={22} />
        <Text size="xs" color="green" sx={{ minWidth: 36, textAlign: "right" }}>
          100%
        </Text>
      </Group>
    );
  } else {
    return <Loader color="red" size={19} />;
  }
};

export default UploadProgressIndicator;
