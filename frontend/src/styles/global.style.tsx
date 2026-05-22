import { MantineTheme } from "@mantine/core";
import { Global } from "@mantine/emotion";

const GlobalStyle = () => {
  return (
    <Global
      styles={(theme: MantineTheme) => ({
        html: {
          scrollbarGutter: "stable",
        },
        a: {
          color: "inherit",
          textDecoration: "none",
        },
        "table.md, table.md th:nth-of-type(odd), table.md td:nth-of-type(odd)":
          {
            background:
              theme.other.colorScheme === "dark"
                ? "rgba(50, 50, 50, 0.5)"
                : "rgba(220, 220, 220, 0.5)",
          },
        "table.md td": {
          paddingLeft: "0.5em",
          paddingRight: "0.5em",
        },
        "@media (max-width: 48em)": {
          ".account-settings > .mantine-Paper-root": {
            padding: "calc(1rem * var(--mantine-scale)) !important",
          },
        },
        "@keyframes progress-stripes": {
          from: { backgroundPosition: "0 0" },
          to: { backgroundPosition: "30px 0" },
        },
      })}
    />
  );
};
export default GlobalStyle;
