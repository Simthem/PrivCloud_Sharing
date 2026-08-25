import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Container,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import Head from "next/head";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  TbCloud,
  TbCode,
  TbDownload,
  TbExternalLink,
  TbPlugConnected,
  TbRefresh,
  TbShieldCheck,
} from "react-icons/tb";
import { useIntl } from "react-intl";
import Meta from "../../components/Meta";
import {
  BridgeHealth,
  getBridgeHealth,
  isOpenSourceBridgeCompatible,
} from "../../services/privcloudBridge.service";

const IntegrationsPage = () => {
  const intl = useIntl();
  const isFr = intl.locale?.startsWith("fr") ?? true;
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [siteOrigin, setSiteOrigin] = useState("https://your-instance.example");

  const compatible = isOpenSourceBridgeCompatible(bridgeHealth);
  const updateRequired = bridgeHealth !== null && !compatible;
  const title = isFr
    ? "Intégrations PrivCloud Companion"
    : "PrivCloud Companion Integrations";
  const description = isFr
    ? "Connectez un cloud WebDAV public via le proxy intégré, ou installez le Companion open source pour les clouds locaux/VPN et les transferts zero-knowledge."
    : "Connect a public WebDAV cloud through the built-in proxy, or install the open-source Companion for local/VPN clouds and zero-knowledge transfers.";
  const installPath = "/install/companion/install/install-linux-dev.sh";
  const installCommand = `curl -fsSL '${siteOrigin}${installPath}' | PRIVCLOUD_BASE_URL='${siteOrigin}' sh`;

  const refresh = async () => {
    setChecking(true);
    try {
      setBridgeHealth(await getBridgeHealth());
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    setSiteOrigin(window.location.origin);
    void refresh();
  }, []);

  const ldJson = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "PrivCloud Companion",
    applicationCategory: "SecurityApplication",
    operatingSystem: "Linux",
    url: `${siteOrigin}/integrations`,
    offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
  };

  return (
    <>
      <Meta title={title} description={description} />
      <Head>
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ldJson) }}
        />
      </Head>

      <Container size="lg" py="xl" px={0}>
        <Group gap="xs" mb="md" c="dimmed">
          <Anchor component={Link} href="/" size="sm" c="dimmed">
            {isFr ? "Accueil" : "Home"}
          </Anchor>
          <Text size="sm" c="dimmed">
            /
          </Text>
          <Text size="sm" c="dimmed">
            {isFr ? "Intégrations" : "Integrations"}
          </Text>
        </Group>

        <Group justify="space-between" align="flex-start" mb="xl">
          <Stack gap="xs">
            <Badge color="teal" variant="light" w="fit-content">
              {isFr ? "Édition open source" : "Open-source edition"}
            </Badge>
            <Title order={1} fz={{ base: 28, sm: 40 }} fw={900} c="bright">
              {title}
            </Title>
            <Text maw={780} c="dimmed" lh={1.7}>
              {description}
            </Text>
          </Stack>
          <Tooltip label={isFr ? "Actualiser" : "Refresh"}>
            <ActionIcon
              variant="light"
              size="lg"
              onClick={refresh}
              loading={checking}
              aria-label={isFr ? "Actualiser" : "Refresh"}
            >
              <TbRefresh size={20} />
            </ActionIcon>
          </Tooltip>
        </Group>

        <Card withBorder radius="md" p="md" mb="xl">
          <Group justify="space-between" align="center">
            <Group gap="sm">
              <TbPlugConnected size={22} />
              <Stack gap={2}>
                <Text fw={700}>
                  {isFr ? "Companion local" : "Local Companion"}
                </Text>
                <Text size="sm" c="dimmed">
                  {bridgeHealth
                    ? `${bridgeHealth.name} ${bridgeHealth.version}`
                    : isFr
                      ? "Non détecté — facultatif pour un WebDAV HTTPS public"
                      : "Not detected — optional for public HTTPS WebDAV"}
                </Text>
              </Stack>
            </Group>
            <Badge
              color={compatible ? "teal" : updateRequired ? "red" : "yellow"}
              variant="light"
            >
              {compatible
                ? isFr
                  ? "Prêt"
                  : "Ready"
                : updateRequired
                  ? isFr
                    ? "Mise à jour requise"
                    : "Update required"
                  : isFr
                    ? "Non installé"
                    : "Not installed"}
            </Badge>
          </Group>
        </Card>

        {updateRequired && (
          <Alert color="red" variant="light" mb="xl">
            {isFr
              ? "Un ancien Companion incompatible a été détecté. Réinstallez ci-dessous la version open source : elle autorise strictement l'instance configurée en local."
              : "An incompatible older Companion was detected. Reinstall the open-source version below: it authorizes only the locally configured instance."}
          </Alert>
        )}

        <Alert
          color="blue"
          variant="light"
          icon={<TbShieldCheck size={18} />}
          mb="xl"
        >
          {isFr
            ? "Le script est servi par votre propre instance et configure explicitement son origine. Il remplace une éventuelle ancienne installation puis redémarre le service utilisateur. Node.js 20 ou supérieur est requis."
            : "The script is served by your own instance and explicitly configures its origin. It replaces any older installation and restarts the user service. Node.js 20 or newer is required."}
        </Alert>

        <Title order={2} size="h3" mb="md" c="bright">
          PrivCloud Companion
        </Title>
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mb="xl">
          <Card withBorder radius="md" p="md" h="100%">
            <Stack gap="sm" h="100%">
              <Group gap="xs">
                <TbDownload size={20} />
                <Text fw={700}>
                  {isFr
                    ? "Installation Linux utilisateur"
                    : "Linux user install"}
                </Text>
              </Group>
              <Text size="sm" c="dimmed" lh={1.6}>
                {isFr
                  ? "Installe le Companion dans ~/.local, limite les origines à cette instance et configure un service systemd utilisateur avec un repli sans systemd."
                  : "Installs Companion under ~/.local, restricts origins to this instance and configures a user systemd service with a non-systemd fallback."}
              </Text>
              <Code block>{installCommand}</Code>
              <Button
                component="a"
                href={installPath}
                variant="light"
                leftSection={<TbDownload size={16} />}
                download
                mt="auto"
              >
                {isFr ? "Télécharger le script" : "Download script"}
              </Button>
            </Stack>
          </Card>

          <Card withBorder radius="md" p="md" h="100%">
            <Stack gap="sm" h="100%">
              <Group gap="xs">
                <TbCode size={20} />
                <Text fw={700}>
                  {isFr ? "Code source distribué" : "Distributed source"}
                </Text>
              </Group>
              <Text size="sm" c="dimmed" lh={1.6}>
                {isFr
                  ? "Consultez exactement le module Companion et les instructions que cette instance distribue."
                  : "Inspect the exact Companion module and instructions distributed by this instance."}
              </Text>
              <Group mt="auto" grow>
                <Button
                  component="a"
                  href="/install/companion/privcloud-companion.mjs"
                  variant="light"
                  leftSection={<TbCode size={16} />}
                >
                  Source
                </Button>
                <Button
                  component="a"
                  href="/install/companion/README.md"
                  variant="light"
                  rightSection={<TbExternalLink size={16} />}
                >
                  README
                </Button>
              </Group>
            </Stack>
          </Card>
        </SimpleGrid>

        <Title order={2} size="h3" mb="md" c="bright">
          WebDAV / Nextcloud
        </Title>
        <Card withBorder radius="md" p="md">
          <Group justify="space-between" align="center" gap="md">
            <Group gap="sm" style={{ flex: 1 }}>
              <TbCloud size={22} />
              <Stack gap={2}>
                <Text fw={700}>
                  {isFr ? "Import cloud intégré" : "Built-in cloud import"}
                </Text>
                <Text size="sm" c="dimmed">
                  {isFr
                    ? "Sans Companion pour un endpoint HTTPS public ; avec Companion pour une adresse privée, locale ou VPN."
                    : "No Companion needed for a public HTTPS endpoint; Companion is used for private, local or VPN addresses."}
                </Text>
              </Stack>
            </Group>
            <Button component={Link} href="/upload">
              {isFr ? "Ouvrir" : "Open"}
            </Button>
          </Group>
        </Card>
      </Container>
    </>
  );
};

export default IntegrationsPage;
