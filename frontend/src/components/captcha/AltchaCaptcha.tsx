import { Box, Center } from "@mantine/core";
import { type Ref } from "react";
import { useAltchaSettings } from "../../hooks/altcha.hook";
import AltchaWidget from "./AltchaWidget";
import type { AltchaWidgetHandle } from "./AltchaWidget";

type AltchaCaptchaProps = {
  onError?: () => void;
  onExpire?: () => void;
  onVerify: (_payload: string) => void;
  widgetRef?: Ref<AltchaWidgetHandle>;
};

const AltchaCaptcha = ({
  onError,
  onExpire,
  onVerify,
  widgetRef,
}: AltchaCaptchaProps) => {
  const { options } = useAltchaSettings();

  return (
    <Center w="100%">
      <Box w="100%" maw={320}>
        <AltchaWidget
          ref={widgetRef}
          onError={onError}
          onExpire={onExpire}
          onVerify={onVerify}
          options={options}
        />
      </Box>
    </Center>
  );
};

export default AltchaCaptcha;
