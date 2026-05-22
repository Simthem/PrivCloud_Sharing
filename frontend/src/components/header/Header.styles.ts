import { rgba } from "@mantine/core";
import { createStyles } from "@mantine/emotion";

export const HEADER_HEIGHT = 60;

export const useStyles = createStyles((theme) => ({
  root: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    width: "100%",
    zIndex: 100,
    backgroundColor:
      theme.other.colorScheme === "dark"
        ? rgba(theme.colors.dark[8], 0.9)
        : rgba(theme.white, 0.92),
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    borderBottom: `1px solid ${
      theme.other.colorScheme === "dark"
        ? theme.colors.dark[4]
        : theme.colors.gray[2]
    }`,
  },

  dropdown: {
    position: "absolute",
    top: HEADER_HEIGHT,
    left: 0,
    right: 0,
    zIndex: 100,
    borderTopRightRadius: 0,
    borderTopLeftRadius: 0,
    borderTop: "none !important",
    overflow: "hidden",

    [`@media (min-width: ${theme.breakpoints.sm})`]: {
      display: "none",
    },
  },

  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    height: "100%",
  },

  links: {
    [`@media (max-width: ${theme.breakpoints.sm})`]: {
      display: "none",
    },
  },

  withIcon: {
    display: "flex",
    alignItems: "center",
    gap: "0.3rem",
  },

  link: {
    display: "block",
    lineHeight: 1,
    padding: "8px 12px",
    borderRadius: theme.radius.sm,
    textDecoration: "none",
    cursor: "pointer",
    userSelect: "none",
    color:
      theme.other.colorScheme === "dark"
        ? theme.colors.dark[0]
        : theme.colors.gray[8],
    fontSize: theme.fontSizes.sm,
    fontWeight: 600,

    "&:hover": {
      backgroundColor:
        theme.other.colorScheme === "dark"
          ? theme.colors.dark[6]
          : theme.colors.gray[0],
    },

    "&:active": {
      transform: "translateY(1px)",
    },

    [`@media (max-width: ${theme.breakpoints.sm})`]: {
      borderRadius: 0,
      padding: theme.spacing.md,
      "&:active": {
        transform: "none",
      },
    },
  },

  linkActive: {
    "&, &:hover": {
      backgroundColor:
        theme.other.colorScheme === "dark"
          ? rgba(theme.colors[theme.primaryColor][9], 0.25)
          : theme.colors[theme.primaryColor][0],
      color:
        theme.colors[theme.primaryColor][theme.other.colorScheme === "dark" ? 3 : 7],
    },
  },

  subLink: {
    paddingLeft: theme.spacing.xl,
    backgroundColor:
      theme.other.colorScheme === "dark"
        ? rgba(theme.black, 0.15)
        : rgba(theme.black, 0.03),
  },
}));
