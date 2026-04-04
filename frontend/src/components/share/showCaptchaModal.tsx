import { Button, Center, Stack, Text, useMantineTheme } from "@mantine/core";
import { ModalsContextProps } from "@mantine/modals/lib/context";
import { useRef, useState } from "react";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { FormattedMessage } from "react-intl";
import { translateOutsideContext } from "../../hooks/useTranslate.hook";

const showCaptchaModal = (
  modals: ModalsContextProps,
  siteKey: string,
  submitCallback: (
    _password?: string,
    _captchaToken?: string,
  ) => Promise<void>,
) => {
  const t = translateOutsideContext();
  return modals.openModal({
    closeOnClickOutside: false,
    withCloseButton: false,
    closeOnEscape: false,
    title: t("share.modal.captcha.title"),
    children: <Body siteKey={siteKey} submitCallback={submitCallback} />,
  });
};

const Body = ({
  siteKey,
  submitCallback,
}: {
  siteKey: string;
  submitCallback: (
    _password?: string,
    _captchaToken?: string,
  ) => Promise<void>;
}) => {
  const captchaRef = useRef<HCaptcha>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const theme = useMantineTheme();

  const handleCaptchaExpire = () => {
    setCaptchaToken(null);
  };

  return (
    <Stack align="stretch">
      <Text size="sm">
        <FormattedMessage id="share.modal.captcha.description" />
      </Text>

      <Center>
        <HCaptcha
          ref={captchaRef}
          sitekey={siteKey}
          onVerify={setCaptchaToken}
          onExpire={handleCaptchaExpire}
          theme={theme.colorScheme}
        />
      </Center>

      <Button
        disabled={!captchaToken}
        loading={isSubmitting}
        onClick={async () => {
          setIsSubmitting(true);
          try {
            await submitCallback(undefined, captchaToken || undefined);
          } catch {
            // Reset captcha on failure so user can retry
            captchaRef.current?.resetCaptcha();
            setCaptchaToken(null);
          } finally {
            setIsSubmitting(false);
          }
        }}
      >
        <FormattedMessage id="share.modal.captcha.submit" />
      </Button>
    </Stack>
  );
};

export default showCaptchaModal;
