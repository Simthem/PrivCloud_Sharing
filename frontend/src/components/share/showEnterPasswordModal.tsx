import { Button, Center, PasswordInput, Stack, Text } from "@mantine/core";
import { ModalsContextProps } from "@mantine/modals/lib/context";
import { useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import useTranslate, {
  translateOutsideContext,
} from "../../hooks/useTranslate.hook";

const showEnterPasswordModal = (
  modals: ModalsContextProps,
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

  const captchaEnabled = !!captchaSiteKey;

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
                onExpire={() => setCaptchaToken(null)}
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
