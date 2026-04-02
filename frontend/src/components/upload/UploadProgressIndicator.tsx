import { Loader, RingProgress, useMantineTheme } from "@mantine/core";
import { TbCircleCheck } from "react-icons/tb";
const UploadProgressIndicator = ({ progress }: { progress: number }) => {
  const theme = useMantineTheme();
  if (progress > 0 && progress < 100) {
    return (
      <RingProgress
        sections={[{ value: progress, color: theme.primaryColor }]}
        thickness={3}
        size={25}
      />
    );
  } else if (progress >= 100) {
    return <TbCircleCheck color="green" size={22} />;
  } else {
    return <Loader color="red" size={19} />;
  }
};

export default UploadProgressIndicator;
