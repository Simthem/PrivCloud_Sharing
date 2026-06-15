import { Collapse, Menu, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import Link from "next/link";
import { TbArrowLoopLeft, TbChevronRight, TbLink, TbSend, TbSignature } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import { useStyles } from "./Header.styles";
import useUser from "../../hooks/user.hook";

const NavbarShareMneu = ({
  onNavigate,
  mobile,
}: {
  onNavigate?: () => void;
  mobile?: boolean;
}) => {
  const { classes, cx } = useStyles();
  const [expanded, { toggle }] = useDisclosure(false);
  const { user } = useUser();

  const showSignature = user?.hasTeamMembership;

  if (mobile) {
    return (
      <>
        <UnstyledButton
          className={cx(classes.link, classes.withIcon)}
          onClick={toggle}
        >
          <TbLink size={14} />
          <FormattedMessage id="navbar.shares" />
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
            href="/account/shares"
            onClick={onNavigate}
            className={cx(classes.link, classes.withIcon, classes.subLink)}
          >
            <TbSend size={14} />
            <FormattedMessage id="navbar.links.shares" />
          </Link>
          <Link
            href="/account/reverseShares"
            onClick={onNavigate}
            className={cx(classes.link, classes.withIcon, classes.subLink)}
          >
            <TbArrowLoopLeft size={14} />
            <FormattedMessage id="navbar.links.reverse" />
          </Link>
          {showSignature && (
            <Link
              href="/signing"
              onClick={onNavigate}
              className={cx(classes.link, classes.withIcon, classes.subLink)}
            >
              <TbSignature size={14} />
              <span style={{ marginLeft: 4 }}>
                <FormattedMessage id="navbar.links.signatures" />
              </span>
            </Link>
          )}
        </Collapse>
      </>
    );
  }

  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <UnstyledButton className={cx(classes.link, classes.withIcon)}>
          <TbLink size={14} />
          <FormattedMessage id="navbar.shares" />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item component={Link} href="/account/shares" leftSection={<TbLink />} onClick={onNavigate}>
          <FormattedMessage id="navbar.links.shares" />
        </Menu.Item>
        <Menu.Item
          component={Link}
          href="/account/reverseShares"
          leftSection={<TbArrowLoopLeft />}
          onClick={onNavigate}
        >
          <FormattedMessage id="navbar.links.reverse" />
        </Menu.Item>
        {showSignature && (
          <Menu.Item
            component={Link}
            href="/signing"
            leftSection={<TbSignature />}
            onClick={onNavigate}
          >
            <FormattedMessage id="navbar.links.signatures" />
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
};

export default NavbarShareMneu;
