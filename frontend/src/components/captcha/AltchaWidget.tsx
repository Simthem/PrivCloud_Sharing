import { Box } from "@mantine/core";
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Configuration, State, VerifyResult } from "altcha/types";
import {
  normalizeAltchaWidgetOptions,
  shouldRevealAltchaDuringVerification,
  type AltchaWidgetOptions,
} from "../../utils/altcha.util";

type AltchaWidgetElement = HTMLElement & {
  configure?: (_config: Partial<Configuration>) => Promise<void>;
  getState?: () => State;
  hide?: () => void;
  reset?: (_newState?: State, _err?: string | null) => void;
  show?: () => void;
  updateUI?: () => void;
  verify?: () => Promise<VerifyResult | null>;
};

export type AltchaWidgetHandle = {
  reset: () => void;
  verify: () => Promise<VerifyResult | null>;
};

type AltchaWidgetProps = {
  challengeUrl?: string;
  onError?: (_error?: string) => void;
  onExpire?: () => void;
  onStateChange?: (_state: State) => void;
  onVerify: (_payload: string) => void;
  options: AltchaWidgetOptions;
};

const AltchaWidget = forwardRef<AltchaWidgetHandle, AltchaWidgetProps>(
  (
    {
      challengeUrl = "/api/altcha/challenge",
      onError,
      onExpire,
      onStateChange,
      onVerify,
      options,
    },
    ref,
  ) => {
    const widgetRef = useRef<AltchaWidgetElement | null>(null);
    const onErrorRef = useRef(onError);
    const [isReady, setIsReady] = useState(false);
    const normalizedOptions = useMemo(
      () => normalizeAltchaWidgetOptions(options),
      [options],
    );

    useEffect(() => {
      onErrorRef.current = onError;
    }, [onError]);

    useEffect(() => {
      let mounted = true;

      import("altcha/i18n")
        .then(() => {
          if (mounted) setIsReady(true);
        })
        .catch((error) => {
          console.warn("[ALTCHA Load Error]", error);
          onErrorRef.current?.(String(error));
        });

      return () => {
        mounted = false;
      };
    }, []);

    useImperativeHandle(ref, () => ({
      reset: () => {
        widgetRef.current?.reset?.();
      },
      verify: async () => {
        const widget = widgetRef.current;
        if (shouldRevealAltchaDuringVerification(normalizedOptions)) {
          widget?.show?.();
          widget?.updateUI?.();
        }

        return (await widget?.verify?.()) ?? null;
      },
    }));

    useEffect(() => {
      const widget = widgetRef.current;
      if (!widget || !isReady) return;

      const handleVerified = (event: Event) => {
        const payload = (event as CustomEvent<{ payload?: string }>).detail
          ?.payload;
        if (payload) {
          onVerify(payload);
        }
      };

      const handleExpired = () => {
        onExpire?.();
      };

      const handleStateChange = (event: Event) => {
        const detail = (event as CustomEvent<{ state?: State }>).detail;
        if (detail?.state) {
          onStateChange?.(detail.state);

          if (shouldRevealAltchaDuringVerification(normalizedOptions)) {
            if (
              ["code", "error", "expired", "verifying"].includes(detail.state)
            ) {
              widget.show?.();
              widget.updateUI?.();
            } else if (detail.state === "verified") {
              window.setTimeout(() => widget.hide?.(), 700);
            }
          }

          if (detail.state === "error") {
            onError?.();
          }
        }
      };

      widget.addEventListener("verified", handleVerified);
      widget.addEventListener("expired", handleExpired);
      widget.addEventListener("statechange", handleStateChange);

      return () => {
        widget.removeEventListener("verified", handleVerified);
        widget.removeEventListener("expired", handleExpired);
        widget.removeEventListener("statechange", handleStateChange);
      };
    }, [
      isReady,
      normalizedOptions,
      onError,
      onExpire,
      onStateChange,
      onVerify,
    ]);

    useEffect(() => {
      const widget = widgetRef.current;
      if (!widget || !isReady) return;

      let disposed = false;

      const applyConfiguration = async () => {
        if (typeof window !== "undefined" && window.customElements) {
          await window.customElements
            .whenDefined("altcha-widget")
            .catch(() => undefined);
        }

        if (disposed || widgetRef.current !== widget) return;

        if (typeof widget.configure !== "function") {
          return;
        }

        try {
          await widget.configure({
            auto: normalizedOptions.auto,
            challenge: challengeUrl,
            codeChallengeDisplay: normalizedOptions.codeChallengeDisplay,
            display: normalizedOptions.display,
            language: normalizedOptions.language,
            name: "altcha",
            test: normalizedOptions.mockChallenge || false,
            type: normalizedOptions.type,
          });
          if (
            shouldRevealAltchaDuringVerification(normalizedOptions) &&
            ["code", "error", "expired", "verifying"].includes(
              widget.getState?.() || "unverified",
            )
          ) {
            widget.show?.();
          }
          widget.updateUI?.();
        } catch (error) {
          console.warn("[ALTCHA Configure Error]", error);
          onErrorRef.current?.(String(error));
        }
      };

      widget.addEventListener("load", applyConfiguration, { once: true });
      void applyConfiguration();

      return () => {
        disposed = true;
        widget.removeEventListener("load", applyConfiguration);
      };
    }, [challengeUrl, isReady, normalizedOptions]);

    const configuration = useMemo(
      () =>
        JSON.stringify({
          codeChallengeDisplay: normalizedOptions.codeChallengeDisplay,
          test: normalizedOptions.mockChallenge || undefined,
        }),
      [normalizedOptions.codeChallengeDisplay, normalizedOptions.mockChallenge],
    );

    if (!isReady) {
      return <Box h={78} />;
    }

    return React.createElement("altcha-widget", {
      auto: normalizedOptions.auto,
      challenge: challengeUrl,
      configuration,
      display: normalizedOptions.display,
      language: normalizedOptions.language,
      name: "altcha",
      ref: widgetRef,
      theme: normalizedOptions.theme,
      type: normalizedOptions.type,
    });
  },
);

AltchaWidget.displayName = "AltchaWidget";

export default AltchaWidget;
