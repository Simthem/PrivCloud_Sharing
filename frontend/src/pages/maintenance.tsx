import {
  Center,
  createStyles,
  keyframes,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { TbTool } from "react-icons/tb";
import Meta from "../components/Meta";
import useConfig from "../hooks/config.hook";
import useTranslate from "../hooks/useTranslate.hook";

const pulse = keyframes({
  "0%, 100%": { transform: "scale(1)", opacity: 0.85 },
  "50%": { transform: "scale(1.08)", opacity: 1 },
});

const useStyles = createStyles((theme) => ({
  wrapper: {
    height: "70vh",
  },
  icon: {
    animation: `${pulse} 3s ease-in-out infinite`,
  },
  card: {
    backgroundColor:
      theme.colorScheme === "dark"
        ? theme.colors.dark[6]
        : theme.colors.gray[0],
    borderRadius: theme.radius.lg,
    padding: `calc(${theme.spacing.xl} * 2)`,
    maxWidth: 520,
    width: "90%",
    boxShadow: theme.shadows.lg,
  },
}));

const Maintenance = () => {
  const { classes } = useStyles();
  const config = useConfig();
  const t = useTranslate();

  const message =
    config.get("general.maintenanceMessage") ||
    t("maintenance.default-message");

  return (
    <>
      <Meta title={t("maintenance.title")} />
      <Center className={classes.wrapper}>
        <div className={classes.card}>
          <Stack align="center" spacing="xl">
            <ThemeIcon
              size={80}
              radius="xl"
              variant="light"
              color="orange"
              className={classes.icon}
            >
              <TbTool size={42} />
            </ThemeIcon>
            <Title order={2} align="center">
              {t("maintenance.title")}
            </Title>
            <Text
              color="dimmed"
              align="center"
              size="md"
              sx={{ whiteSpace: "pre-line" }}
            >
              {message}
            </Text>
          </Stack>
        </div>
      </Center>
    </>
  );
};

export default Maintenance;
