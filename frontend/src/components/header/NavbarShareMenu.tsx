import { Collapse, Menu, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import Link from "next/link";
import { TbArrowLoopLeft, TbChevronRight, TbLink } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import { useStyles } from "./Header.styles";

const NavbarShareMneu = ({
  onNavigate,
  mobile,
}: {
  onNavigate?: () => void;
  mobile?: boolean;
}) => {
  const { classes, cx } = useStyles();
  const [expanded, { toggle }] = useDisclosure(false);

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
            <TbLink size={14} />
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
        <Menu.Item component={Link} href="/account/shares" icon={<TbLink />} onClick={onNavigate}>
          <FormattedMessage id="navbar.links.shares" />
        </Menu.Item>
        <Menu.Item
          component={Link}
          href="/account/reverseShares"
          icon={<TbArrowLoopLeft />}
          onClick={onNavigate}
        >
          <FormattedMessage id="navbar.links.reverse" />
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
};

export default NavbarShareMneu;
