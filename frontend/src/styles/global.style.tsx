import { MantineTheme } from "@mantine/core";
import { Global } from "@mantine/emotion";

const GlobalStyle = () => {
  return (
    <Global
      styles={(theme: MantineTheme) => ({
        html: {
          scrollbarGutter: "stable",
        },
        body: {
          backgroundColor: "#000",
          backgroundImage: [
            "linear-gradient(to right, rgba(245, 158, 11, 0.16) 0%, rgba(245, 158, 11, 0) 50%)",
            "linear-gradient(to left,  rgba(245, 158, 11, 0.16) 0%, rgba(245, 158, 11, 0) 50%)",
          ].join(", "),
          backgroundSize: "100% 100%",
          backgroundRepeat: "no-repeat",
        },
        a: {
          color: "inherit",
          textDecoration: "none",
        },
        "h1, h2, h3, h4, h5, h6, .mantine-Title-root": {
          overflowWrap: "anywhere",
          wordBreak: "normal",
          hyphens: "auto",
        },
        ".mantine-Text-root, .mantine-Anchor-root, .mantine-Table-th, .mantine-Table-td":
          {
            overflowWrap: "anywhere",
            wordBreak: "normal",
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
        "altcha-widget": {
          "--altcha-border-radius": "6px",
          "--altcha-color-primary": "var(--mantine-color-primary-6)",
          "--altcha-color-success": "var(--mantine-color-green-6)",
          display: "block",
          width: "100%",
        },
        "altcha-widget .altcha-main": {
          width: "100%",
        },
        'altcha-widget[theme="lime"]': {
          "--altcha-color-primary": "var(--mantine-color-lime-7)",
          "--altcha-color-success": "var(--mantine-color-lime-6)",
          "--altcha-color-neutral": "var(--mantine-color-lime-2)",
          "--altcha-checkbox-border-color": "var(--mantine-color-lime-6)",
        },
        'altcha-widget[theme="aqua"]': {
          "--altcha-color-primary": "var(--mantine-color-cyan-6)",
          "--altcha-color-success": "var(--mantine-color-teal-6)",
          "--altcha-color-neutral": "var(--mantine-color-cyan-2)",
          "--altcha-checkbox-border-color": "var(--mantine-color-cyan-5)",
        },
        'altcha-widget[theme="business"]': {
          "--altcha-color-primary": "var(--mantine-color-blue-7)",
          "--altcha-color-success": "var(--mantine-color-teal-7)",
          "--altcha-color-neutral": "var(--mantine-color-gray-3)",
          "--altcha-checkbox-border-color": "var(--mantine-color-gray-5)",
        },
        'altcha-widget[theme="caramel"]': {
          "--altcha-color-primary": "var(--mantine-color-orange-7)",
          "--altcha-color-success": "var(--mantine-color-yellow-7)",
          "--altcha-color-neutral": "var(--mantine-color-orange-2)",
          "--altcha-checkbox-border-color": "var(--mantine-color-orange-5)",
        },
        'altcha-widget[theme="cupcake"]': {
          "--altcha-color-primary": "var(--mantine-color-pink-6)",
          "--altcha-color-success": "var(--mantine-color-grape-5)",
          "--altcha-color-neutral": "var(--mantine-color-pink-1)",
          "--altcha-checkbox-border-color": "var(--mantine-color-pink-4)",
        },
        'altcha-widget[theme="cyberpunk"]': {
          "--altcha-color-primary": "var(--mantine-color-yellow-6)",
          "--altcha-color-success": "var(--mantine-color-lime-5)",
          "--altcha-color-neutral": "var(--mantine-color-violet-3)",
          "--altcha-checkbox-border-color": "var(--mantine-color-yellow-5)",
        },
        'altcha-widget[theme="wireframe"]': {
          "--altcha-border-radius": "0px",
          "--altcha-color-primary": "var(--mantine-color-dark-6)",
          "--altcha-color-success": "var(--mantine-color-gray-7)",
          "--altcha-color-neutral": "var(--mantine-color-gray-4)",
          "--altcha-checkbox-border-color": "var(--mantine-color-dark-4)",
        },
        "@media (max-width: 48em)": {
          ".account-settings > .mantine-Paper-root": {
            padding: "calc(1rem * var(--mantine-scale)) !important",
          },
          ".mantine-Text-root[data-truncate], .mantine-Text-root[data-line-clamp], .mantine-Anchor-root[data-line-clamp], .mantine-Title-root[data-line-clamp]":
            {
              display: "block",
              overflow: "visible",
              textOverflow: "clip",
              whiteSpace: "normal",
              WebkitBoxOrient: "initial",
              WebkitLineClamp: "unset",
              overflowWrap: "anywhere",
              wordBreak: "normal",
              hyphens: "auto",
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
