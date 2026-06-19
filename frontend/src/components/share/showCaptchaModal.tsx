import { Button, Stack, Text } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import AltchaCaptcha from "../captcha/AltchaCaptcha";
import type { AltchaWidgetHandle } from "../captcha/AltchaWidget";
import { useAltchaSettings } from "../../hooks/altcha.hook";
import { translateOutsideContext } from "../../hooks/useTranslate.hook";

const showCaptchaModal = (
  modals: ReturnType<typeof useModals>,
  submitCallback: (_password?: string, _captchaToken?: string) => Promise<void>,
) => {
  const t = translateOutsideContext();
  return modals.openModal({
    closeOnClickOutside: false,
    withCloseButton: false,
    closeOnEscape: false,
    title: t("share.modal.captcha.title"),
    children: <Body submitCallback={submitCallback} />,
  });
};

const Body = ({
  submitCallback,
}: {
  submitCallback: (_password?: string, _captchaToken?: string) => Promise<void>;
}) => {
  const captchaRef = useRef<AltchaWidgetHandle>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const altcha = useAltchaSettings();

  const handleCaptchaExpire = () => {
    setCaptchaToken(null);
  };

  const handleCaptchaError = () => {
    setCaptchaToken(null);
    captchaRef.current?.reset();
  };

  const resolveCaptchaToken = async () => {
    if (captchaToken) return captchaToken;

    const result = await captchaRef.current?.verify();
    if (result?.payload) {
      setCaptchaToken(result.payload);
      return result.payload;
    }

    return undefined;
  };

  return (
    <Stack align="stretch">
      <Text size="sm">
        <FormattedMessage id="share.modal.captcha.description" />
      </Text>

      <AltchaCaptcha
        widgetRef={captchaRef}
        onVerify={setCaptchaToken}
        onExpire={handleCaptchaExpire}
        onError={handleCaptchaError}
      />

      <Button
        disabled={altcha.shouldWaitForToken && !captchaToken}
        loading={isSubmitting}
        onClick={async () => {
          setIsSubmitting(true);
          try {
            const token = await resolveCaptchaToken();
            if (!token) return;

            await submitCallback(undefined, token);
          } catch {
            // Reset captcha on failure so user can retry.
            captchaRef.current?.reset();
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
