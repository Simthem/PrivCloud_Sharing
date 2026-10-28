import {
  Alert,
  Button,
  Group,
  Modal,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  getDefaultZIndex,
} from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { TbFingerprint } from "react-icons/tb";
import useTranslate from "../../hooks/useTranslate.hook";
import authService, { type StepUpMethods } from "../../services/auth.service";
import passkeyService from "../../services/passkey.service";
import { setStepUpHandler } from "../../utils/stepUp.util";
import toast from "../../utils/toast.util";

// Only these providers state when the user really signed in (OIDC auth_time).
const FRESH_SIGN_IN_PROVIDERS = ["google", "oidc"];

type Pending = { scope: string; resolve: (_confirmed: boolean) => void };

/**
 * Asks the user to confirm their identity before a sensitive operation
 * (administrator rights, someone else's credentials, sign-in settings, a new
 * signing passkey), then lets the API client replay it.
 */
const StepUpHost = () => {
  const t = useTranslate();
  const [pending, setPending] = useState<Pending | null>(null);
  const [methods, setMethods] = useState<StepUpMethods | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const returnHandled = useRef(false);

  useEffect(() => {
    setStepUpHandler(
      (scope) =>
        new Promise<boolean>((resolve) => {
          setPending((previous) => {
            // A newer operation replaces one left unanswered.
            previous?.resolve(false);
            return { scope, resolve };
          });
        }),
    );
    return () => setStepUpHandler(null);
  }, []);

  useEffect(() => {
    if (!pending) return;
    setMethods(null);
    authService
      .getStepUpMethods()
      .then(setMethods)
      .catch(() =>
        setMethods({
          password: true,
          totp: false,
          passkey: false,
          providers: [],
        }),
      );
  }, [pending]);

  // Back from the provider: the proof waits in an httpOnly cookie for the
  // next confirmation, so the administrator repeats the operation.
  useEffect(() => {
    if (returnHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("stepUpReauth") !== "1") return;
    returnHandled.current = true;
    params.delete("stepUpReauth");
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname +
        (query ? `?${query}` : "") +
        window.location.hash,
    );
    toast.success(t("step-up.oauth-returned"));
  }, [t]);

  const close = (confirmed: boolean) => {
    pending?.resolve(confirmed);
    setPending(null);
    setPassword("");
    setCode("");
    setError(null);
  };

  const refusal = (failure: unknown) => {
    const response = (
      failure as { response?: { status?: number; data?: { message?: string } } }
    )?.response;
    if (response?.status === 403) return t("step-up.wrong-proof");
    if (response?.status === 400) return t("step-up.wrong-code");
    return response?.data?.message ?? t("step-up.error");
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await authService.confirmStepUp(pending.scope, {
        password: methods?.password ? password : undefined,
        code: code.trim() || undefined,
      });
      close(true);
    } catch (failure) {
      setError(refusal(failure));
    } finally {
      setBusy(false);
    }
  };

  const confirmWithPasskey = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await passkeyService.confirmStepUp(pending.scope);
      close(true);
    } catch (failure) {
      // Closing the browser prompt is not an error worth showing.
      if ((failure as Error)?.name !== "NotAllowedError") {
        setError(t("step-up.passkey-error"));
      }
    } finally {
      setBusy(false);
    }
  };

  // The server sends the user back to this page, if it is one it knows.
  const confirmWithProvider = (provider: string) => {
    close(false);
    window.location.assign(
      new URL(
        `/api/oauth/reauth/${encodeURIComponent(provider)}?purpose=step-up` +
          `&return=${encodeURIComponent(window.location.pathname)}`,
        window.location.origin,
      ).toString(),
    );
  };

  const providers = (methods?.providers ?? []).filter((provider) =>
    FRESH_SIGN_IN_PROVIDERS.includes(provider),
  );
  const needsCode = !!methods?.totp;
  const usable =
    !!methods && (methods.password || methods.passkey || providers.length > 0);

  return (
    <Modal
      opened={!!pending}
      onClose={() => close(false)}
      title={t("step-up.title")}
      // Opens over the dialog whose request it confirms, such as the
      // administrator's user editor, never behind it.
      zIndex={getDefaultZIndex("modal") + 10}
    >
      <Stack gap="sm">
        <Text size="sm">
          {t(
            pending?.scope.startsWith("signing.passkey.enroll:")
              ? "step-up.description.signing-passkey"
              : "step-up.description.admin",
          )}
        </Text>
        {methods && !usable && (
          <Alert color="orange">{t("step-up.none")}</Alert>
        )}
        {methods?.passkey && (
          <Button
            variant="light"
            leftSection={<TbFingerprint size={14} />}
            loading={busy}
            onClick={confirmWithPasskey}
          >
            {t("step-up.passkey")}
          </Button>
        )}
        {(methods?.password || providers.length > 0) && (
          <>
            {methods?.password && (
              <PasswordInput
                label={t("step-up.password")}
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                autoComplete="current-password"
                data-autofocus
              />
            )}
            {needsCode && (
              <TextInput
                label={t("account.modal.totp.codeOrBackup")}
                placeholder="123456 / A1B2C3D4"
                value={code}
                onChange={(event) => setCode(event.currentTarget.value)}
                autoComplete="one-time-code"
              />
            )}
            {providers.length > 0 && (
              <Group>
                {providers.map((provider) => (
                  <Button
                    key={provider}
                    variant="light"
                    disabled={busy}
                    onClick={() => confirmWithProvider(provider)}
                  >
                    {t("account.card.security.totp.oauth.confirm", {
                      provider: t(`account.card.oauth.${provider}`),
                    })}
                  </Button>
                ))}
              </Group>
            )}
          </>
        )}
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="right">
          <Button variant="default" onClick={() => close(false)}>
            {t("common.button.cancel")}
          </Button>
          {(methods?.password || providers.length > 0) && (
            <Button
              loading={busy}
              disabled={
                (methods?.password && !password) ||
                (needsCode && code.trim().length < 6)
              }
              onClick={confirm}
            >
              {t("step-up.confirm")}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
};

export default StepUpHost;
