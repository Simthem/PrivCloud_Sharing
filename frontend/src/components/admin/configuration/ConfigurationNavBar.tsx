import { Box, Button, Group, Stack, Text, ThemeIcon } from "@mantine/core";
import { createStyles } from "@mantine/emotion";
import Link from "next/link";
import { Dispatch, SetStateAction } from "react";
import {
  TbAt,
  TbBell,
  TbBinaryTree,
  TbBucket,
  TbMail,
  TbScale,
  TbServerBolt,
  TbSettings,
  TbShare,
  TbShieldCheck,
  TbSocial,
} from "react-icons/tb";
import { FormattedMessage } from "react-intl";

const categories = [
  { name: "General", icon: <TbSettings /> },
  { name: "Email", icon: <TbMail /> },
  { name: "Share", icon: <TbShare /> },
  { name: "SMTP", icon: <TbAt /> },
  { name: "OAuth", icon: <TbSocial /> },
  { name: "LDAP", icon: <TbBinaryTree /> },
  { name: "S3", icon: <TbBucket /> },
  { name: "Legal", icon: <TbScale /> },
  { name: "Cache", icon: <TbServerBolt /> },
  { name: "Altcha", icon: <TbShieldCheck /> },
  { name: "PushNotifications", id: "pushNotifications", icon: <TbBell /> },
];

const useStyles = createStyles((theme) => ({
  activeLink: {
    backgroundColor: `var(--mantine-primary-color-light)`,
    color: `var(--mantine-primary-color-light-color)`,

    borderRadius: theme.radius.sm,
    fontWeight: 600,
  },
}));

const ConfigurationNavBar = ({
  categoryId,
  isMobileNavBarOpened: _isMobileNavBarOpened,
  setIsMobileNavBarOpened,
}: {
  categoryId: string;
  isMobileNavBarOpened: boolean;
  setIsMobileNavBarOpened: Dispatch<SetStateAction<boolean>>;
}) => {
  const { classes } = useStyles();
  return (
    <Box component="nav" p="md">
      <Box>
        <Text size="xs" c="dimmed" mb="sm">
          <FormattedMessage id="admin.config.title" />
        </Text>
        <Stack gap="xs">
          {categories.map((category) => (
            <Box
              p="xs"
              component={Link}
              onClick={() => setIsMobileNavBarOpened(false)}
              className={
                categoryId == (category.id ?? category.name.toLowerCase())
                  ? classes.activeLink
                  : undefined
              }
              key={category.name}
              href={`/admin/config/${category.id ?? category.name.toLowerCase()}`}
            >
              <Group>
                <ThemeIcon
                  variant={
                    categoryId == (category.id ?? category.name.toLowerCase())
                      ? "filled"
                      : "light"
                  }
                >
                  {category.icon}
                </ThemeIcon>
                <Text size="sm">
                  <FormattedMessage
                    id={`admin.config.category.${(category.id ?? category.name).toLowerCase()}`}
                  />
                </Text>
              </Group>
            </Box>
          ))}
        </Stack>
      </Box>
      <Button
        mt="xl"
        variant="light"
        component={Link}
        href="/admin"
        hiddenFrom="sm"
      >
        <FormattedMessage id="common.button.go-back" />
      </Button>
    </Box>
  );
};

export default ConfigurationNavBar;
