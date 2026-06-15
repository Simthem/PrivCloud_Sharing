import {
  Collapse,
  Loader,
  Menu,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useState } from "react";
import Link from "next/link";
import { TbChevronRight, TbDoorExit, TbSettings, TbUser, TbUsersGroup } from "react-icons/tb";
import useUser from "../../hooks/user.hook";
import authService from "../../services/auth.service";
import { FormattedMessage } from "react-intl";
import { useStyles } from "./Header.styles";
import { useQuery } from "@tanstack/react-query";
import teamService from "../../services/team.service";

const ActionAvatar = ({
  onNavigate,
  mobile,
}: {
  onNavigate?: () => void;
  mobile?: boolean;
}) => {
  const { user } = useUser();
  const { classes, cx } = useStyles();
  const [expanded, { toggle }] = useDisclosure(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const hasTeamAccess = !!user;

  const { data: teams } = useQuery({
    queryKey: ["teams.list"],
    queryFn: () => teamService.getMyTeams(),
    enabled: hasTeamAccess,
    staleTime: 60_000,
  });

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      onNavigate?.();
      await authService.signOut();
    } catch (e) {
      console.error("SignOut failed:", e);
      // Page reload will happen regardless from auth.service.ts
    } finally {
      // Note: page will reload before this is called, but keep for safety
      setIsSigningOut(false);
    }
  };

  if (mobile) {
    return (
      <>
        <UnstyledButton
          className={cx(classes.link, classes.withIcon)}
          onClick={toggle}
        >
          <TbUser size={14} />
          {user?.username}
          <TbChevronRight
            size={14}
            style={{
              marginLeft: "auto",
              transform: expanded ? "rotate(90deg)" : "none",
              transition: "transform 200ms ease",
            }}
          />
        </UnstyledButton>
        <Collapse in={expanded}>
          <Link
            href="/account"
            onClick={onNavigate}
            className={cx(classes.link, classes.withIcon, classes.subLink)}
          >
            <TbUser size={14} />
            <FormattedMessage id="navbar.avatar.account" />
          </Link>
          {(teams && teams.length > 0 || hasTeamAccess) && (
            <Link
              href={teams && teams.length === 1 ? `/team/${teams[0].id}` : "/team"}
              onClick={onNavigate}
              className={cx(classes.link, classes.withIcon, classes.subLink)}
            >
              <TbUsersGroup size={14} />
              <FormattedMessage id="navbar.avatar.my-team" />
            </Link>
          )}
          {user!.isAdmin && (
            <Link
              href="/admin"
              onClick={onNavigate}
              className={cx(classes.link, classes.withIcon, classes.subLink)}
            >
              <TbSettings size={14} />
              <FormattedMessage id="navbar.avatar.admin" />
            </Link>
          )}
          <UnstyledButton
            onClick={handleSignOut}
            disabled={isSigningOut}
            className={cx(classes.link, classes.withIcon, classes.subLink)}
            style={{ opacity: isSigningOut ? 0.6 : 1 }}
          >
            {isSigningOut ? (
              <Loader size={14} />
            ) : (
              <TbDoorExit size={14} />
            )}
            <FormattedMessage id="navbar.avatar.signout" />
          </UnstyledButton>
        </Collapse>
      </>
    );
  }

  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <UnstyledButton className={cx(classes.link, classes.withIcon)}>
          <TbUser size={14} />
          {user?.username}
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item component={Link} href="/account" leftSection={<TbUser size={14} />} onClick={onNavigate}>
          <FormattedMessage id="navbar.avatar.account" />
        </Menu.Item>
        {(teams && teams.length > 0 || hasTeamAccess) && (
          <Menu.Item
            component={Link}
            href={teams && teams.length === 1 ? `/team/${teams[0].id}` : "/team"}
            leftSection={<TbUsersGroup size={14} />}
            onClick={onNavigate}
          >
            <FormattedMessage id="navbar.avatar.my-team" />
          </Menu.Item>
        )}
        {user!.isAdmin && (
          <Menu.Item
            component={Link}
            href="/admin"
            leftSection={<TbSettings size={14} />}
            onClick={onNavigate}
          >
            <FormattedMessage id="navbar.avatar.admin" />
          </Menu.Item>
        )}

        <Menu.Item
          onClick={handleSignOut}
          disabled={isSigningOut}
          leftSection={isSigningOut ? <Loader size={14} /> : <TbDoorExit size={14} />}
        >
          <FormattedMessage id="navbar.avatar.signout" />
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
};

export default ActionAvatar;
