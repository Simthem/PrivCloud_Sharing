import { useMemo } from "react";
import {
  normalizeAltchaWidgetOptions,
  shouldWaitForAltchaToken,
} from "../utils/altcha.util";
import type { AltchaWidgetOptions } from "../utils/altcha.util";
import useConfig from "./config.hook";

export const useAltchaSettings = () => {
  const config = useConfig();

  const options = useMemo<AltchaWidgetOptions>(
    () =>
      normalizeAltchaWidgetOptions({
        auto: config.get("altcha.auto"),
        codeChallengeDisplay: config.get("altcha.codeChallengeDisplay"),
        display: config.get("altcha.display"),
        language: config.get("altcha.language"),
        theme: config.get("altcha.theme"),
        type: config.get("altcha.type"),
      }),
    [config],
  );

  return {
    enabled: Boolean(config.get("altcha.enabled")),
    options,
    shouldWaitForToken: shouldWaitForAltchaToken(options),
  };
};
