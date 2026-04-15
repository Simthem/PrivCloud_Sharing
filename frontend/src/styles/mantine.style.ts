import { MantineThemeOverride } from "@mantine/core";

// Predefined color palettes selectable by the administrator
export const COLOR_PALETTES: Record<string, { colors: Record<string, string[]>; primaryColor: string }> = {
  victoria: {
    colors: {
      victoria: [
        "#E2E1F1",
        "#C2C0E7",
        "#A19DE4",
        "#7D76E8",
        "#544AF4",
        "#4940DE",
        "#4239C8",
        "#463FA8",
        "#47428E",
        "#464379",
      ],
    },
    primaryColor: "victoria",
  },
  stprive: {
    colors: {
      stprive: [
        "#E8F5E9",
        "#C8E6C9",
        "#A5D6A7",
        "#81C784",
        "#66BB6A",
        "#4CAF50",
        "#43A047",
        "#388E3C",
        "#2E7D32",
        "#1B5E20",
      ],
    },
    primaryColor: "stprive",
  },
  ocean: {
    colors: {
      ocean: [
        "#E0F2F1",
        "#B2DFDB",
        "#80CBC4",
        "#4DB6AC",
        "#26A69A",
        "#009688",
        "#00897B",
        "#00796B",
        "#00695C",
        "#004D40",
      ],
    },
    primaryColor: "ocean",
  },
  crimson: {
    colors: {
      crimson: [
        "#FFE5E5",
        "#FFC2C2",
        "#FF9E9E",
        "#FF7A7A",
        "#FF5252",
        "#E63946",
        "#CC2D3B",
        "#A32430",
        "#7A1B24",
        "#521218",
      ],
    },
    primaryColor: "crimson",
  },
  amber: {
    colors: {
      amber: [
        "#FFF8E1",
        "#FFECB3",
        "#FFE082",
        "#FFD54F",
        "#FFCA28",
        "#FFC107",
        "#D97706",
        "#B45309",
        "#92400E",
        "#78350F",
      ],
    },
    primaryColor: "amber",
  },
  slate: {
    colors: {
      slate: [
        "#ECEFF1",
        "#CFD8DC",
        "#B0BEC5",
        "#90A4AE",
        "#78909C",
        "#607D8B",
        "#546E7A",
        "#455A64",
        "#37474F",
        "#263238",
      ],
    },
    primaryColor: "slate",
  },
};

export function buildTheme(paletteName?: string): MantineThemeOverride {
  const palette = COLOR_PALETTES[paletteName ?? "victoria"] ?? COLOR_PALETTES.victoria;

  // WCAG AA contrast helpers
  // Compute relative luminance of a hex color per WCAG 2.1
  const luminance = (hex: string): number => {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const lin = (c: number) =>
      c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };

  // For variant="light": pick a high-contrast text shade on a faint tinted bg.
  const lightVariantColor = (theme: any, color: string | undefined, isDark: boolean) => {
    const c = color ?? theme.primaryColor;
    const colors = theme.colors[c];
    if (!colors) return {};
    return { color: colors[isDark ? 2 : 9] };
  };

  // For variant="filled": if the background shade is too bright for white text,
  // switch to dark text automatically (e.g. amber, yellow palettes).
  const filledTextColor = (theme: any, color: string | undefined) => {
    const c = color ?? theme.primaryColor;
    const shade =
      typeof theme.primaryShade === "object"
        ? theme.primaryShade[theme.colorScheme] ?? 7
        : theme.primaryShade ?? 7;
    const bgHex = theme.colors[c]?.[shade];
    if (!bgHex || typeof bgHex !== "string" || !bgHex.startsWith("#")) return {};
    // Luminance > 0.183 means white text cannot reach 4.5:1 contrast ratio
    return luminance(bgHex) > 0.183 ? { color: theme.black } : {};
  };

  // Explicit text color for elements sitting on a primary-color background
  // (e.g. selected dropdown items).  Unlike filledTextColor which returns {}
  // when white text is fine, this ALWAYS returns an explicit color.
  const onPrimaryBg = (theme: any): { color: string } => {
    const c = theme.primaryColor;
    const shade =
      typeof theme.primaryShade === "object"
        ? theme.primaryShade[theme.colorScheme] ?? 7
        : theme.primaryShade ?? 7;
    const bgHex = theme.colors[c]?.[shade];
    if (!bgHex || typeof bgHex !== "string" || !bgHex.startsWith("#"))
      return { color: theme.white };
    return luminance(bgHex) > 0.183
      ? { color: theme.black }
      : { color: theme.white };
  };

  // Helper: build a "defaultProps.styles" function that injects the filled
  // text-color fix at the component-styles level (highest CSS priority in
  // Mantine's merge chain). This is more robust than relying solely on
  // theme-level styles which may lose CSS specificity races in portals
  // (used by modals).
  const filledDefaultStyles = () => ({
    defaultProps: (theme: any) => ({
      styles: (t: any, params: any, ctx: any) => {
        if (ctx?.variant !== "filled") return {};
        const fix = filledTextColor(t, params?.color);
        if (!fix.color) return {};
        return { root: fix, label: fix };
      },
    }),
  });

  return {
    colors: palette.colors as any,
    primaryColor: palette.primaryColor,
    primaryShade: { light: 8, dark: 5 },
    components: {
      Modal: {
        styles: (theme: any) => ({
          title: {
            fontSize: theme.fontSizes.lg,
            fontWeight: 700,
          },
        }),
      },
      Button: {
        ...filledDefaultStyles(),
        styles: (theme: any, params: any, { variant }: any) => {
          const isDark = theme.colorScheme === "dark";
          const filled = variant === "filled" ? filledTextColor(theme, params.color) : {};
          return {
            root: {
              ...filled,
              ...(variant === "light" ? lightVariantColor(theme, params.color, isDark) : {}),
              ...(variant === "outline" && isDark
                ? {
                    color: theme.colors[params.color ?? theme.primaryColor]?.[3],
                    borderColor: theme.colors[params.color ?? theme.primaryColor]?.[4],
                  }
                : {}),
            },
            label: {
              fontWeight: 600,
              ...filled,
              ...(variant === "subtle"
                ? { color: theme.colors[params.color ?? theme.primaryColor]?.[isDark ? 3 : 8] }
                : {}),
            },
          };
        },
      },
      ActionIcon: {
        ...filledDefaultStyles(),
        styles: (theme: any, params: any, { variant }: any) => {
          const isDark = theme.colorScheme === "dark";
          return {
            root: {
              ...(variant === "filled" ? filledTextColor(theme, params.color) : {}),
              ...(variant === "light" ? lightVariantColor(theme, params.color, isDark) : {}),
            },
          };
        },
      },
      ThemeIcon: {
        styles: (theme: any, params: any, { variant }: any) => {
          const isDark = theme.colorScheme === "dark";
          return {
            root: {
              ...(variant === "filled" ? filledTextColor(theme, params.color) : {}),
              ...(variant === "light" ? lightVariantColor(theme, params.color, isDark) : {}),
            },
          };
        },
      },
      Anchor: {
        styles: (theme: any) => ({
          root: {
            color: theme.colors[theme.primaryColor][theme.colorScheme === "dark" ? 3 : 8],
            fontWeight: 500,
          },
        }),
      },
      Badge: {
        ...filledDefaultStyles(),
        styles: (theme: any, params: any, { variant }: any) => {
          const isDark = theme.colorScheme === "dark";
          return {
            root: {
              ...(variant === "filled" ? filledTextColor(theme, params.color) : {}),
              ...(variant === "light" ? lightVariantColor(theme, params.color, isDark) : {}),
            },
          };
        },
      },
      Progress: {
        styles: (theme: any) => {
          const fix = filledTextColor(theme, undefined);
          return { label: fix.color ? fix : {} };
        },
      },
      Select: {
        styles: (theme: any) => {
          const isDark = theme.colorScheme === "dark";
          return {
            input: isDark ? { color: theme.white } : {},
            item: {
              "&[data-selected], &[data-selected][data-hovered]": onPrimaryBg(theme),
            },
          };
        },
      },
      NativeSelect: {
        styles: (theme: any) => {
          const isDark = theme.colorScheme === "dark";
          return { input: isDark ? { color: theme.white } : {} };
        },
      },
      MultiSelect: {
        styles: (theme: any) => {
          const isDark = theme.colorScheme === "dark";
          return {
            input: isDark ? { color: theme.white } : {},
            value: isDark ? { color: theme.white } : {},
            item: {
              "&[data-selected], &[data-selected][data-hovered]": onPrimaryBg(theme),
            },
          };
        },
      },
      Switch: {
        styles: (theme: any) => {
          const c = theme.primaryColor;
          const shade =
            typeof theme.primaryShade === "object"
              ? theme.primaryShade[theme.colorScheme] ?? 7
              : theme.primaryShade ?? 7;
          const trackBg = theme.colors[c]?.[shade];
          // If the track is too bright, use a darker shade for better contrast
          // and darken the thumb shadow for visibility.
          const isBright =
            trackBg &&
            typeof trackBg === "string" &&
            trackBg.startsWith("#") &&
            luminance(trackBg) > 0.183;
          // Use a noticeably darker shade for the "on" track
          const darkerShade = Math.min(shade + 2, 9);
          return {
            track: isBright
              ? {
                  "input:checked + &": {
                    backgroundColor: theme.colors[c][darkerShade],
                    borderColor: theme.colors[c][darkerShade],
                  },
                }
              : {},
          };
        },
      },
    },
  };
}
