import { Group, Stack, Text } from "@mantine/core";
import { createStyles } from "@mantine/emotion";
import dynamic from "next/dynamic";
import useTranslate from "../../hooks/useTranslate.hook";

const OAuthProviderButton = dynamic(() => import("./OAuthProviderButton"), {
  ssr: false,
});

const useStyles = createStyles((theme) => {
  const line = {
    content: "''",
    flex: 1,
    display: "block",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderColor:
      theme.other.colorScheme === "dark"
        ? theme.colors.dark[3]
        : theme.colors.gray[4],
  } as const;
  const space = { content: "''", flex: 1, display: "block" } as const;
  return {
    divider: { "&:before": line, "&:after": line },
    heading: { fontWeight: 500, "&:before": space, "&:after": space },
  };
});

const OAuthProviders = ({
  providers,
  onlyMethod = false,
}: {
  providers: string[];
  onlyMethod?: boolean;
}) => {
  const t = useTranslate();
  const { classes } = useStyles();

  if (providers.length === 0) return null;

  return (
    <Stack mt={onlyMethod ? undefined : "xl"}>
      <Group
        align="center"
        className={onlyMethod ? classes.heading : classes.divider}
      >
        <Text size={onlyMethod ? undefined : "sm"}>
          {t(
            onlyMethod
              ? "signIn.oauth.signInWith"
              : "signIn.oauth.continueWith",
          )}
        </Text>
      </Group>
      <Group justify="center">
        {providers.map((provider) => (
          <OAuthProviderButton
            key={provider}
            provider={provider}
            label={t(`signIn.oauth.${provider}`)}
          />
        ))}
      </Group>
    </Stack>
  );
};

export default OAuthProviders;
