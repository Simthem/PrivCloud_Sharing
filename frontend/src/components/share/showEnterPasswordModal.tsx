import { Button, PasswordInput, Stack, Text } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import AltchaCaptcha from "../captcha/AltchaCaptcha";
import type { AltchaWidgetHandle } from "../captcha/AltchaWidget";
import { useAltchaSettings } from "../../hooks/altcha.hook";
import useTranslate, {
  translateOutsideContext,
} from "../../hooks/useTranslate.hook";

const showEnterPasswordModal = (
  modals: ReturnType<typeof useModals>,
  submitCallback: (_password: string, _captchaToken?: string) => Promise<void>,
  captchaEnabled?: boolean,
) => {
  const t = translateOutsideContext();
  return modals.openModal({
    closeOnClickOutside: false,
    withCloseButton: false,
    closeOnEscape: false,
    title: t("share.modal.password.title"),
    children: (
      <Body submitCallback={submitCallback} captchaEnabled={captchaEnabled} />
    ),
  });
};

const Body = ({
  submitCallback,
  captchaEnabled,
}: {
  submitCallback: (_password: string, _captchaToken?: string) => Promise<void>;
  captchaEnabled?: boolean;
}) => {
  const [password, setPassword] = useState("");
  const [passwordWrong, setPasswordWrong] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaRef = useRef<AltchaWidgetHandle>(null);
  const altcha = useAltchaSettings();
  const t = useTranslate();

  const resetCaptcha = () => {
    setCaptchaToken(null);
    captchaRef.current?.reset();
  };
  const handleCaptchaExpire = () => setCaptchaToken(null);
  const handleCaptchaError = resetCaptcha;

  const resolveCaptchaToken = async () => {
    if (!captchaEnabled) return undefined;
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
        <FormattedMessage id="share.modal.password.description" />
      </Text>

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const token = await resolveCaptchaToken();
            if (captchaEnabled && !token) return;

            await submitCallback(password, token);
          } catch (error) {
            if (
              (error as { response?: { data?: { error?: string } } })?.response
                ?.data?.error === "share_password_required"
            ) {
              setPasswordWrong(true);
            }
            resetCaptcha();
          }
        }}
      >
        <Stack>
          <PasswordInput
            variant="filled"
            placeholder={t("share.modal.password")}
            error={passwordWrong && t("share.modal.error.invalid-password")}
            onFocus={() => setPasswordWrong(false)}
            onChange={(e) => setPassword(e.target.value)}
            value={password}
          />
          {captchaEnabled && (
            <AltchaCaptcha
              widgetRef={captchaRef}
              onVerify={setCaptchaToken}
              onExpire={handleCaptchaExpire}
              onError={handleCaptchaError}
            />
          )}
          <Button
            type="submit"
            disabled={
              captchaEnabled && altcha.shouldWaitForToken && !captchaToken
            }
          >
            <FormattedMessage id="common.button.submit" />
          </Button>
        </Stack>
      </form>
    </Stack>
  );
};

export default showEnterPasswordModal;
