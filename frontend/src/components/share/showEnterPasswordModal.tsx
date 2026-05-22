import { Button, Center, PasswordInput, Stack, Text, useMantineTheme } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import useTranslate, {
  translateOutsideContext,
} from "../../hooks/useTranslate.hook";

const showEnterPasswordModal = (
  modals: ReturnType<typeof useModals>,
  submitCallback: (
    _password: string,
    _captchaToken?: string,
  ) => Promise<void>,
  captchaSiteKey?: string,
) => {
  const t = translateOutsideContext();
  return modals.openModal({
    closeOnClickOutside: false,
    withCloseButton: false,
    closeOnEscape: false,
    title: t("share.modal.password.title"),
    children: (
      <Body submitCallback={submitCallback} captchaSiteKey={captchaSiteKey} />
    ),
  });
};

const Body = ({
  submitCallback,
  captchaSiteKey,
}: {
  submitCallback: (
    _password: string,
    _captchaToken?: string,
  ) => Promise<void>;
  captchaSiteKey?: string;
}) => {
  const [password, setPassword] = useState("");
  const [passwordWrong, setPasswordWrong] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaRef = useRef<HCaptcha>(null);
  const t = useTranslate();
  const theme = useMantineTheme();

  const captchaEnabled = !!captchaSiteKey;

  const handleCaptchaExpire = () => setCaptchaToken(null);
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
        <FormattedMessage id="share.modal.password.description" />
      </Text>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitCallback(password, captchaToken || undefined);
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
            <Center>
              <HCaptcha
                ref={captchaRef}
                sitekey={captchaSiteKey!}
                onVerify={setCaptchaToken}
                onExpire={handleCaptchaExpire}
                onError={handleCaptchaError}
                theme={theme.other.colorScheme}
              />
            </Center>
          )}
          <Button
            type="submit"
            disabled={captchaEnabled && !captchaToken}
          >
            <FormattedMessage id="common.button.submit" />
          </Button>
        </Stack>
      </form>
    </Stack>
  );
};

export default showEnterPasswordModal;
