import {
  Box,
  Burger,
  Button,
  Group,
  Text,
  useMantineTheme,
} from "@mantine/core";
import Link from "next/link";
import { Dispatch, SetStateAction } from "react";
import { FormattedMessage } from "react-intl";
import useConfig from "../../../hooks/config.hook";
import Logo from "../../Logo";

const ConfigurationHeader = ({
  isMobileNavBarOpened,
  setIsMobileNavBarOpened,
}: {
  isMobileNavBarOpened: boolean;
  setIsMobileNavBarOpened: Dispatch<SetStateAction<boolean>>;
}) => {
  const config = useConfig();
  const theme = useMantineTheme();
  return (
    <Box component="header" h={60} p="md">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: "100%" }}>
        <Link href="/" passHref>
          <Group>
            <Logo height={35} width={35} />
            <Text fw={600}>{config.get("general.appName")}</Text>
          </Group>
        </Link>
        <Button variant="light" component={Link} href="/admin" visibleFrom="sm">
            <FormattedMessage id="common.button.go-back" />
        </Button>
        <Burger
            opened={isMobileNavBarOpened}
            onClick={() => setIsMobileNavBarOpened((o) => !o)}
            size="sm"
            color={theme.colors.gray[6]}
            aria-label="Toggle navigation menu"
            hiddenFrom="sm"
        />
      </div>
    </Box>
  );
};

export default ConfigurationHeader;
