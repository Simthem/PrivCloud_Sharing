import { createTheme, MantineColorScheme } from "@mantine/core";

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
        "#F59E0B",
        "#D97706",
        "#B45309",
        "#92400E",
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

// WCAG AA contrast helpers
// Compute relative luminance of a hex color per WCAG 2.1
export const wcagLuminance = (hex: string): number => {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

export function buildTheme(paletteName?: string, colorScheme: MantineColorScheme = "dark") {
  const palette = COLOR_PALETTES[paletteName ?? "victoria"] ?? COLOR_PALETTES.victoria;
  const isDark = colorScheme === "dark";

  const luminance = wcagLuminance;

  // For variant="light": pick a high-contrast text shade on a faint tinted bg.
  const lightVariantColor = (theme: any, color: string | undefined) => {
    const c = color ?? theme.primaryColor;
    const colors = theme.colors[c];
    if (!colors) return {};
    return { color: colors[isDark ? 4 : 8] };
  };

  // For variant="filled": if the background shade is too bright for white text,
  // switch to dark text automatically (e.g. amber, yellow palettes).
  const filledTextColor = (theme: any, color: string | undefined) => {
    const c = color ?? theme.primaryColor;
    const shade = isDark ? 6 : 8;
    const bgHex = theme.colors[c]?.[shade];
    if (!bgHex || typeof bgHex !== "string" || !bgHex.startsWith("#")) return {};
    return luminance(bgHex) > 0.183 ? { color: theme.black } : {};
  };

  // Explicit text color for elements sitting on a primary-color background.
  const onPrimaryBg = (theme: any): { color: string } => {
    const c = theme.primaryColor;
    const shade = isDark ? 6 : 8;
    const bgHex = theme.colors[c]?.[shade];
    if (!bgHex || typeof bgHex !== "string" || !bgHex.startsWith("#"))
      return { color: theme.white };
    return luminance(bgHex) > 0.183
      ? { color: theme.black }
      : { color: theme.white };
  };

  return createTheme({
    colors: {
      ...(palette.colors as any),
      dark: [
        "#C1C2C5",
        "#A6A7AB",
        "#909296",
        "#5c5f66",
        "#373A40",
        "#2C2E33",
        "#25262b",
        "#141517",
        "#111214",
        "#0D0E10",
      ],
    },
    primaryColor: palette.primaryColor,
    primaryShade: { light: 8, dark: 6 },
    other: { colorScheme },
    components: {
      Modal: {
        styles: (theme: any) => ({
          title: {
            fontSize: theme.fontSizes.lg,
            fontWeight: 700,
            color: theme.colors[theme.primaryColor][isDark ? 4 : 7],
          },
        }),
      },
      Button: {
        styles: (theme: any, props: any) => {
          const isFilled = !props.variant || props.variant === "filled";
          const filled = isFilled ? filledTextColor(theme, props.color) : {};
          return {
            root: {
              ...filled,
              ...(props.variant === "light" ? lightVariantColor(theme, props.color) : {}),
              ...(props.variant === "outline" && isDark
                ? {
                    color: theme.colors[props.color ?? theme.primaryColor]?.[3],
                    borderColor: theme.colors[props.color ?? theme.primaryColor]?.[4],
                  }
                : {}),
            },
            label: {
              fontWeight: 600,
              ...filled,
              ...(props.variant === "subtle"
                ? { color: theme.colors[props.color ?? theme.primaryColor]?.[isDark ? 3 : 8] }
                : {}),
            },
          };
        },
      },
      ActionIcon: {
        styles: (theme: any, props: any) => ({
          root: {
            ...(!props.variant || props.variant === "filled" ? filledTextColor(theme, props.color) : {}),
            ...(props.variant === "light" ? lightVariantColor(theme, props.color) : {}),
          },
        }),
      },
      ThemeIcon: {
        styles: (theme: any, props: any) => ({
          root: {
            ...(!props.variant || props.variant === "filled" ? filledTextColor(theme, props.color) : {}),
            ...(props.variant === "light" ? lightVariantColor(theme, props.color) : {}),
          },
        }),
      },
      Anchor: {
        styles: (theme: any) => ({
          root: {
            color: theme.colors[theme.primaryColor][isDark ? 3 : 8],
            fontWeight: 500,
          },
        }),
      },
      Badge: {
        styles: (theme: any, props: any) => ({
          root: {
            ...(!props.variant || props.variant === "filled" ? filledTextColor(theme, props.color) : {}),
            ...(props.variant === "light" ? lightVariantColor(theme, props.color) : {}),
          },
        }),
      },
      Progress: {
        styles: (theme: any) => {
          const fix = filledTextColor(theme, undefined);
          return { label: fix.color ? fix : {} };
        },
      },
      Select: {
        styles: (theme: any) => ({
          input: isDark ? { color: theme.white } : {},
          option: {
            "&[data-selected], &[data-selected][data-hovered]": onPrimaryBg(theme),
          },
        }),
      },
      NativeSelect: {
        styles: (theme: any) => ({
          input: isDark ? { color: theme.white } : {},
        }),
      },
      MultiSelect: {
        styles: (theme: any) => ({
          input: isDark ? { color: theme.white } : {},
          option: {
            "&[data-selected], &[data-selected][data-hovered]": onPrimaryBg(theme),
          },
        }),
      },
      Alert: {
        styles: (theme: any, props: any) => {
          const c = props.color ?? theme.primaryColor;
          const colors = theme.colors[c];
          if (!colors) return {};
          return {
            root: isDark
              ? { backgroundColor: `rgba(${parseInt(colors[6]?.slice(1,3),16)}, ${parseInt(colors[6]?.slice(3,5),16)}, ${parseInt(colors[6]?.slice(5,7),16)}, 0.15)` }
              : { backgroundColor: colors[0] },
            title: { color: colors[isDark ? 4 : 7], fontWeight: 600 },
          };
        },
      },
      Notification: {
        defaultProps: {
          withBorder: true,
          radius: "md",
        },
        styles: (theme: any) => ({
          root: {
            background: isDark
              ? "linear-gradient(135deg, rgba(20, 21, 23, 0.99), rgba(28, 30, 35, 0.99))"
              : "linear-gradient(135deg, rgba(255, 255, 255, 0.99), rgba(248, 249, 250, 0.99))",
            borderColor: isDark
              ? "rgba(255, 255, 255, 0.16)"
              : "rgba(15, 23, 42, 0.14)",
            boxShadow: isDark
              ? "0 18px 48px rgba(0, 0, 0, 0.48), 0 0 0 1px rgba(255, 255, 255, 0.04)"
              : "0 18px 42px rgba(15, 23, 42, 0.16), 0 0 0 1px rgba(15, 23, 42, 0.04)",
            backdropFilter: "blur(14px) saturate(1.15)",
            WebkitBackdropFilter: "blur(14px) saturate(1.15)",
          },
          title: {
            color: isDark ? theme.white : theme.black,
            fontWeight: 700,
          },
          description: {
            color: isDark ? theme.colors.dark[0] : theme.colors.gray[8],
            lineHeight: 1.45,
            overflowWrap: "anywhere",
          },
          closeButton: {
            color: isDark ? theme.colors.dark[1] : theme.colors.gray[7],
            "&:hover": {
              backgroundColor: isDark
                ? "rgba(255, 255, 255, 0.08)"
                : "rgba(15, 23, 42, 0.06)",
            },
          },
        }),
      },
      Switch: {
        styles: (theme: any) => {
          const c = theme.primaryColor;
          const shade = isDark ? 6 : 8;
          const trackBg = theme.colors[c]?.[shade];
          const isBright =
            trackBg &&
            typeof trackBg === "string" &&
            trackBg.startsWith("#") &&
            luminance(trackBg) > 0.183;
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
  });
}
