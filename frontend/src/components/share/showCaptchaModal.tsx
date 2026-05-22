import { Button, Center, Stack, Text, useMantineTheme } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { useRef, useState } from "react";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { FormattedMessage } from "react-intl";
import { translateOutsideContext } from "../../hooks/useTranslate.hook";

const showCaptchaModal = (
  modals: ReturnType<typeof useModals>,
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

  const handleCaptchaError = (error: any) => {
    console.warn("[hCaptcha Error]", error);
    // Attempt to reset the captcha on error (e.g., WebGL context lost on Safari)
    if (captchaRef.current?.resetCaptcha) {
      captchaRef.current.resetCaptcha();
    }
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
          onError={handleCaptchaError}
          theme={theme.other.colorScheme}
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
