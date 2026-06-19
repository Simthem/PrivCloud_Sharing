import type { Configuration } from "altcha/types";

export type AltchaWidgetOptions = Pick<
  Configuration,
  "auto" | "codeChallengeDisplay" | "display" | "language" | "type"
> & {
  mockChallenge?: boolean;
  theme: string;
};

export const ALTCHA_ALGORITHM_SELECT_OPTIONS = [
  { value: "PBKDF2/SHA-256", label: "PBKDF2/SHA-256" },
  { value: "PBKDF2/SHA-384", label: "PBKDF2/SHA-384" },
  { value: "PBKDF2/SHA-512", label: "PBKDF2/SHA-512" },
];

export const ALTCHA_AUTO_MODES = [
  "onload",
  "onfocus",
  "onsubmit",
  "off",
] as const satisfies readonly Configuration["auto"][];

export const ALTCHA_CODE_CHALLENGE_DISPLAY_MODES = [
  "standard",
  "overlay",
  "bottomsheet",
] as const satisfies readonly Configuration["codeChallengeDisplay"][];

export const ALTCHA_DISPLAY_MODES = [
  "standard",
  "bar",
  "floating",
  "overlay",
  "invisible",
] as const satisfies readonly Configuration["display"][];

export const ALTCHA_TYPE_MODES = [
  "checkbox",
  "native",
  "switch",
] as const satisfies readonly Configuration["type"][];

const asSelectOptions = <T extends string>(values: readonly T[]) =>
  values.map((value) => ({ value, label: value }));

export const ALTCHA_AUTO_SELECT_OPTIONS = asSelectOptions(ALTCHA_AUTO_MODES);
export const ALTCHA_CODE_CHALLENGE_DISPLAY_SELECT_OPTIONS = asSelectOptions(
  ALTCHA_CODE_CHALLENGE_DISPLAY_MODES,
);
export const ALTCHA_DISPLAY_SELECT_OPTIONS = asSelectOptions(
  ALTCHA_DISPLAY_MODES,
);
export const ALTCHA_TYPE_SELECT_OPTIONS = asSelectOptions(ALTCHA_TYPE_MODES);

const normalizeStandardAlias = (value: string) =>
  value === "standart" ? "standard" : value;

const normalizeString = (value: unknown, fallback: string) =>
  typeof value === "string" && value ? value : fallback;

const normalizeOption = <T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  fallback: T,
): T => {
  if (typeof value !== "string" || !value) return fallback;

  const normalizedValue = normalizeStandardAlias(value);
  return allowedValues.includes(normalizedValue as T)
    ? (normalizedValue as T)
    : fallback;
};

export const normalizeAltchaWidgetOptions = (
  options: Partial<Record<keyof AltchaWidgetOptions, unknown>>,
): AltchaWidgetOptions => {
  const normalized: AltchaWidgetOptions = {
    auto: normalizeOption(options.auto, ALTCHA_AUTO_MODES, "onload"),
    codeChallengeDisplay: normalizeOption(
      options.codeChallengeDisplay,
      ALTCHA_CODE_CHALLENGE_DISPLAY_MODES,
      "standard",
    ),
    display: normalizeOption(
      options.display,
      ALTCHA_DISPLAY_MODES,
      "standard",
    ),
    language: normalizeString(options.language, "fr-fr"),
    theme: normalizeString(options.theme, "lime"),
    type: normalizeOption(options.type, ALTCHA_TYPE_MODES, "checkbox"),
  };

  if (typeof options.mockChallenge === "boolean") {
    normalized.mockChallenge = options.mockChallenge;
  }

  return normalized;
};

export const shouldWaitForAltchaToken = (
  options: Pick<AltchaWidgetOptions, "auto" | "display">,
) => options.auto === "off" && options.display === "standard";

export const shouldRevealAltchaDuringVerification = (
  options: Pick<AltchaWidgetOptions, "display">,
) => ["bar", "floating", "overlay"].includes(options.display);
