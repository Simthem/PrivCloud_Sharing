import {
  Button,
  Container,
  Group,
  List,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import Link from "next/link";
import { useRouter } from "next/router";
import { TbCheck } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import Logo from "../components/Logo";
import Meta from "../components/Meta";
import useUser from "../hooks/user.hook";
import useConfig from "../hooks/config.hook";
import { useEffect, useState } from "react";
import { createStyles } from "@mantine/emotion";

const useStyles = createStyles((theme) => ({
  inner: {
    display: "flex",
    justifyContent: "space-between",
    paddingTop: `calc(${theme.spacing.md} * 4)`,
    paddingBottom: `calc(${theme.spacing.md} * 4)`,
  },

  content: {
    maxWidth: 480,
    marginRight: `calc(${theme.spacing.md} * 3)`,

    [`@media (max-width: ${theme.breakpoints.md})`]: {
      maxWidth: "100%",
      marginRight: 0,
    },
  },

  title: {
    color: "var(--mantine-color-text)",
    fontSize: 44,
    lineHeight: 1.2,
    fontWeight: 900,

    [`@media (max-width: ${theme.breakpoints.xs})`]: {
      fontSize: 28,
    },
  },

  control: {
    [`@media (max-width: ${theme.breakpoints.xs})`]: {
      flex: 1,
    },
  },

  image: {
    [`@media (max-width: ${theme.breakpoints.md})`]: {
      display: "none",
    },
  },

  highlight: {
    position: "relative",
    backgroundColor: "var(--mantine-primary-color-light)",
    borderRadius: theme.radius.sm,
    padding: "1.2px 12px 4px 12px",
  },
}));

export default function Home() {
  const { classes } = useStyles();
  const { user } = useUser();
  const router = useRouter();
  const config = useConfig();
  const [signupEnabled, setSignupEnabled] = useState(true);

  // If user is already authenticated, redirect to the upload page.
  useEffect(() => {
    if (user) {
      router.replace("/upload");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    try {
      const allowRegistration = config.get("share.allowRegistration");
      setSignupEnabled(allowRegistration !== false);
    } catch {
      setSignupEnabled(true);
    }
  }, [config]);

  const getButtonHref = () => {
    return signupEnabled ? "/auth/signUp" : "/auth/signIn";
  };

  return (
    <>
      <Meta title="Home" />
      <Container>
        <div className={classes.inner}>
          <div className={classes.content}>
            <Title className={classes.title}>
              <FormattedMessage
                id="home.title"
                values={{
                  h: (chunks) => (
                    <span className={classes.highlight}>{chunks}</span>
                  ),
                }}
              />
            </Title>
            <Text c="dimmed" mt="md" fw={500}>
              <FormattedMessage id="home.description" />
            </Text>

            <List
              mt={30}
              spacing="sm"
              size="sm"
              icon={
                <ThemeIcon size={20} radius="xl">
                  <TbCheck size={12} />
                </ThemeIcon>
              }
            >
              <List.Item>
                <div>
                  <b>
                    <FormattedMessage id="home.bullet.a.name" />
                  </b>{" "}
                  - <FormattedMessage id="home.bullet.a.description" />
                </div>
              </List.Item>
              <List.Item>
                <div>
                  <b>
                    <FormattedMessage id="home.bullet.b.name" />
                  </b>{" "}
                  - <FormattedMessage id="home.bullet.b.description" />
                </div>
              </List.Item>
              <List.Item>
                <div>
                  <b>
                    <FormattedMessage id="home.bullet.c.name" />
                  </b>{" "}
                  - <FormattedMessage id="home.bullet.c.description" />
                </div>
              </List.Item>
            </List>

            <Group mt={30}>
              <Button
                component={Link}
                href={getButtonHref()}
                radius="xl"
                size="md"
                className={classes.control}
              >
                <FormattedMessage id="home.button.start" />
              </Button>
              <Button
                component={Link}
                href="https://github.com/Simthem/PrivCloud_Sharing"
                target="_blank"
                variant="default"
                radius="xl"
                size="md"
                className={classes.control}
              >
                <FormattedMessage id="home.button.source" />
              </Button>
            </Group>
          </div>
          <Group className={classes.image} align="center">
            <Logo width={200} height={200} src="/img/logo-200x200.webp" />
          </Group>
        </div>
      </Container>
    </>
  );
}
