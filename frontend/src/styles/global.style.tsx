import { MantineTheme } from "@mantine/core";
import { Global } from "@mantine/emotion";

import { MOTION_EASING } from "./motion.style";

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
            },
        },
        // Floating dropdowns grow from the side of their control. Only the
        // Popover transition sets a transform on these elements.
        '[data-position^="bottom"]': { transformOrigin: "top center" },
        '[data-position="bottom-start"]': { transformOrigin: "top left" },
        '[data-position="bottom-end"]': { transformOrigin: "top right" },
        '[data-position^="top"]': { transformOrigin: "bottom center" },
        '[data-position="top-start"]': { transformOrigin: "bottom left" },
        '[data-position="top-end"]': { transformOrigin: "bottom right" },
        '[data-position^="left"]': { transformOrigin: "right center" },
        '[data-position^="right"]': { transformOrigin: "left center" },
        // A tab's content fades in when it is shown instead of replacing the
        // previous one at once. Opacity only: a transform would move fixed
        // descendants during the animation.
        ".mantine-Tabs-panel": {
          animation: `tab-panel-enter 200ms ${MOTION_EASING}`,
        },
        "@keyframes tab-panel-enter": {
          from: { opacity: 0 },
          to: { opacity: 1 },
        },
        // What a disclosure reveals eases in, one item after the other when
        // the items number themselves with --reveal-order.
        "[data-reveal]": {
          animation: `reveal-enter 260ms ${MOTION_EASING} both`,
          animationDelay: "calc(min(var(--reveal-order, 0), 8) * 35ms)",
        },
        "@keyframes reveal-enter": {
          from: { opacity: 0, transform: "translateY(-6px)" },
          to: { opacity: 1, transform: "none" },
        },
        // Chevrons of disclosures turn with them: a quarter turn to the
        // right by default, a half turn for those pointing down.
        "[data-disclosure-chevron]": {
          flexShrink: 0,
          transition: `transform 240ms ${MOTION_EASING}`,
        },
        "[data-disclosure-chevron][data-opened]": {
          transform: "rotate(90deg)",
        },
        '[data-disclosure-chevron="down"][data-opened]': {
          transform: "rotate(180deg)",
        },
        "@media (prefers-reduced-motion: reduce)": {
          ".mantine-Tabs-panel, [data-reveal]": { animation: "none" },
          "[data-disclosure-chevron]": { transition: "none" },
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
