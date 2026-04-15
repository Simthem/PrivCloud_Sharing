import {
  Collapse,
  Menu,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import Link from "next/link";
import { TbChevronRight, TbDoorExit, TbSettings, TbUser } from "react-icons/tb";
import useUser from "../../hooks/user.hook";
import authService from "../../services/auth.service";
import { FormattedMessage } from "react-intl";
import { useStyles } from "./Header.styles";

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
            onClick={async () => {
              onNavigate?.();
              await authService.signOut();
            }}
            className={cx(classes.link, classes.withIcon, classes.subLink)}
          >
            <TbDoorExit size={14} />
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
        <Menu.Item component={Link} href="/account" icon={<TbUser size={14} />} onClick={onNavigate}>
          <FormattedMessage id="navbar.avatar.account" />
        </Menu.Item>
        {user!.isAdmin && (
          <Menu.Item
            component={Link}
            href="/admin"
            icon={<TbSettings size={14} />}
            onClick={onNavigate}
          >
            <FormattedMessage id="navbar.avatar.admin" />
          </Menu.Item>
        )}

        <Menu.Item
          onClick={async () => {
            onNavigate?.();
            await authService.signOut();
          }}
          icon={<TbDoorExit size={14} />}
        >
          <FormattedMessage id="navbar.avatar.signout" />
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
};

export default ActionAvatar;
