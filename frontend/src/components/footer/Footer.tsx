import { ActionIcon, Anchor, Box, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { TbBrandGithub, TbBrandLinkedin } from "react-icons/tb";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";

const Footer = () => {
  const t = useTranslate();
  const config = useConfig();
  const hasImprint = !!(
    config.get("legal.imprintUrl") || config.get("legal.imprintText")
  );
  const hasPrivacy = !!(
    config.get("legal.privacyPolicyUrl") ||
    config.get("legal.privacyPolicyText")
  );
  const imprintUrl =
    (!config.get("legal.imprintText") && config.get("legal.imprintUrl")) ||
    "/imprint";
  const privacyUrl =
    (!config.get("legal.privacyPolicyText") &&
      config.get("legal.privacyPolicyUrl")) ||
    "/privacy";

  const isMobile = useMediaQuery("(max-width: 700px)");

  return (
    <Box component="footer" h="auto" py={10} px="xl" style={{ zIndex: 100 }}>
      {isMobile ? (
        <Stack gap={6} align="center">
          <Text size="sm" c="dimmed" fw={500} ta="center" lh={1.5}>
            Powered by{" "}
            <Anchor
              size="sm"
              href="https://github.com/Simthem/PrivCloud_Sharing"
              target="_blank"
            >
              PrivCloud_Sharing
            </Anchor>
            <br />
            Secured infrastructure by{" "}
            <Anchor
              size="sm"
              href="https://www.stprive.net/"
              target="_blank"
            >
              THEMIOT Informatique - Consultant Cybersécurité
            </Anchor>
          </Text>
          {config.get("legal.enabled") && (
            <Text size="sm" c="dimmed" fw={500} ta="center">
              {hasImprint && (
                <Anchor size="sm" href={imprintUrl}>
                  {t("imprint.title")}
                </Anchor>
              )}
              {hasImprint && hasPrivacy && " • "}
              {hasPrivacy && (
                <Anchor size="sm" href={privacyUrl}>
                  {t("privacy.title")}
                </Anchor>
              )}
            </Text>
          )}
          <Group gap="xs" justify="center" mt={4}>
            <ActionIcon
              component="a"
              href="https://github.com/Simthem"
              target="_blank"
              rel="me noopener"
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="GitHub"
            >
              <TbBrandGithub size={18} />
            </ActionIcon>
            <ActionIcon
              component="a"
              href="https://www.linkedin.com/in/simon-th%C3%A9miot-3733911ba"
              target="_blank"
              rel="me noopener"
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="LinkedIn"
            >
              <TbBrandLinkedin size={18} />
            </ActionIcon>
          </Group>
        </Stack>
      ) : (
        <SimpleGrid cols={3} m={0}>
          <div></div>
          <Text size="sm" c="dimmed" fw={500} ta="center">
            Powered by{" "}
            <Anchor
              size="sm"
              href="https://github.com/Simthem/PrivCloud_Sharing"
              target="_blank"
            >
              PrivCloud_Sharing
            </Anchor>{" "}
            <br />
            Secured infrastructure by{" "}
            <Anchor
              size="sm"
              href="https://www.stprive.net/"
              target="_blank"
            >
              THEMIOT Informatique - Consultant Cybersécurité
            </Anchor>
          </Text>
          <div>
            {config.get("legal.enabled") && (
              <Text size="sm" c="dimmed" fw={500} ta="right">
                {hasImprint && (
                  <Anchor size="sm" href={imprintUrl}>
                    {t("imprint.title")}
                  </Anchor>
                )}
                {hasImprint && hasPrivacy && " • "}
                {hasPrivacy && (
                  <Anchor size="sm" href={privacyUrl}>
                    {t("privacy.title")}
                  </Anchor>
                )}
              </Text>
            )}
            <Group gap="xs" justify="flex-end" mt={4}>
              <ActionIcon
                component="a"
                href="https://github.com/Simthem"
                target="_blank"
                rel="me noopener"
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="GitHub"
              >
                <TbBrandGithub size={18} />
              </ActionIcon>
              <ActionIcon
                component="a"
                href="https://www.linkedin.com/in/simon-th%C3%A9miot-3733911ba"
                target="_blank"
                rel="me noopener"
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="LinkedIn"
              >
                <TbBrandLinkedin size={18} />
              </ActionIcon>
            </Group>
          </div>
        </SimpleGrid>
      )}
    </Box>
  );
};

export default Footer;
