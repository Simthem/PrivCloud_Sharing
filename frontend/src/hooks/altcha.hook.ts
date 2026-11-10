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
        auto: config.getString("altcha.auto"),
        codeChallengeDisplay: config.getString("altcha.codeChallengeDisplay"),
        display: config.getString("altcha.display"),
        language: config.getString("altcha.language"),
        theme: config.getString("altcha.theme"),
        type: config.getString("altcha.type"),
      }),
    [config],
  );

  return {
    enabled: Boolean(config.getBoolean("altcha.enabled")),
    options,
    shouldWaitForToken: shouldWaitForAltchaToken(options),
  };
};
