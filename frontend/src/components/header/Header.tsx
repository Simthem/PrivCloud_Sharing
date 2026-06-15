import {
  Box,
  Burger,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  Transition,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import Link from "next/link";
import { useRouter } from "next/router";
import { Fragment, ReactNode, useEffect, useState } from "react";
import useConfig from "../../hooks/config.hook";
import useUser from "../../hooks/user.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import teamService from "../../services/team.service";
import Logo from "../Logo";
import ActionAvatar from "./ActionAvatar";
import NavbarShareMenu from "./NavbarShareMenu";
import NotificationBell from "./NotificationBell";
import TeamNotificationPanel from "./TeamNotificationPanel";
import { useStyles, HEADER_HEIGHT } from "./Header.styles";
import { TbUpload } from "react-icons/tb";

type NavLink = {
  link?: string;
  label?: string;
  icon?: ReactNode;
  component?: ReactNode;
  action?: () => Promise<void>;
};

const Header = () => {
  const { user } = useUser();
  const router = useRouter();
  const config = useConfig();
  const t = useTranslate();

  const [opened, toggleOpened] = useDisclosure(false);

  const [currentRoute, setCurrentRoute] = useState("");
  const [homeLink, setHomeLink] = useState("/upload");
  const [isTeamUser, setIsTeamUser] = useState(false);
  const isMobileViewport = useMediaQuery("(max-width: 47.99em)");

  useEffect(() => {
    setCurrentRoute(router.pathname);
  }, [router.pathname]);

  useEffect(() => {
    if (!user) { setHomeLink("/upload"); setIsTeamUser(false); return; }
    teamService.getTeamStatus().then((status) => {
      const inTeam = !!(status.ownsTeam || status.isTeamMember);
      setIsTeamUser(inTeam);
      if (status.ownsTeam && status.ownedTeamId) {
        setHomeLink(`/team/${status.ownedTeamId}`);
      } else {
        setHomeLink("/upload");
      }
    }).catch(() => { setHomeLink("/upload"); setIsTeamUser(false); });
  }, [user]);

  const authenticatedLinks: NavLink[] = [
    {
      link: "/upload",
      icon: <TbUpload size={14} />,
      label: t("navbar.upload"),
    },
    {
      component: <NavbarShareMenu onNavigate={toggleOpened.close} />,
    },
    {
      component: <ActionAvatar onNavigate={toggleOpened.close} />,
    },
  ];

  let unauthenticatedLinks: NavLink[] = [
    {
      link: "/auth/signIn",
      label: t("navbar.signin"),
    },
  ];

  if (config.get("share.allowUnauthenticatedShares")) {
    unauthenticatedLinks.unshift({
      link: "/upload",
      icon: <TbUpload size={14} />,
      label: t("navbar.upload"),
    });
  }

  if (config.get("general.showHomePage"))
    unauthenticatedLinks.unshift({
      link: "/",
      label: t("navbar.home"),
    });

  if (config.get("share.allowRegistration"))
    unauthenticatedLinks.push({
      link: "/auth/signUp",
      label: t("navbar.signup"),
    });

  const { classes, cx } = useStyles();
  const items = (
    <>
      {(user ? authenticatedLinks : unauthenticatedLinks).map((link, i) => {
        if (link.component) {
          return <Fragment key={i}>{link.component}</Fragment>;
        }
        return (
          <Link
            key={i}
            href={link.link ?? ""}
            onClick={() => toggleOpened.toggle()}
            className={cx(classes.link, {
              [classes.linkActive]: currentRoute == link.link,
              [classes.withIcon]: !!link.icon,
            })}
          >
            {link.icon}
            {link.label}
          </Link>
        );
      })}
    </>
  );

  const mobileItems = (
    <>
      {user ? (
        <>
          <Link
            href="/upload"
            onClick={toggleOpened.close}
            className={cx(classes.link, classes.withIcon, {
              [classes.linkActive]: currentRoute == "/upload",
            })}
          >
            <TbUpload size={14} />
            {t("navbar.upload")}
          </Link>
          <NavbarShareMenu mobile onNavigate={toggleOpened.close} />
          <ActionAvatar mobile onNavigate={toggleOpened.close} />
        </>
      ) : (
        unauthenticatedLinks.map((link, i) => (
          <Link
            key={i}
            href={link.link ?? ""}
            onClick={toggleOpened.close}
            className={cx(classes.link, {
              [classes.linkActive]: currentRoute == link.link,
              [classes.withIcon]: !!link.icon,
            })}
          >
            {link.icon}
            {link.label}
          </Link>
        ))
      )}
    </>
  );

  return (
    <Box component="header" h={HEADER_HEIGHT} className={classes.root}>
      <Container className={classes.header}>
        <Link href={user ? homeLink : "/"} passHref>
          <Group>
            <Logo height={35} width={35} />
            <Text fw={600}>{config.get("general.appName")}</Text>
          </Group>
        </Link>
        <Group gap={5} className={classes.links}>
          {user && isTeamUser && !isMobileViewport && <TeamNotificationPanel />}
          {user && !isTeamUser && !isMobileViewport && <NotificationBell />}
          <Group>{items} </Group>
        </Group>
          <Group gap={8} wrap="nowrap" hiddenFrom="sm">
            {user && isTeamUser && isMobileViewport && <TeamNotificationPanel />}
            {user && !isTeamUser && isMobileViewport && <NotificationBell />}
            <Burger
              opened={opened}
              onClick={() => toggleOpened.toggle()}
              size="sm"
              aria-label="Toggle navigation menu"
            />
          </Group>
        <Transition transition="pop-top-right" duration={200} mounted={opened}>
          {(styles) => (
            <Paper className={classes.dropdown} withBorder style={styles}>
              <Stack gap={0}>{mobileItems}</Stack>
            </Paper>
          )}
        </Transition>
      </Container>
    </Box>
  );
};

export default Header;
