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
import { useEffect, useMemo, useState } from "react";
import {
  TbBrandAndroid,
  TbBrandChrome,
  TbBrandFirefox,
  TbBrandGmail,
  TbBrandWindows,
  TbCloud,
  TbDownload,
  TbExternalLink,
  TbMail,
  TbPlugConnected,
  TbRefresh,
  TbShieldCheck,
} from "react-icons/tb";
import { useIntl } from "react-intl";
import Meta from "../../components/Meta";
import {
  getBridgeHealth,
  BridgeHealth,
} from "../../services/privcloudBridge.service";
import {
  CompanionExtensionState,
  getCompanionExtensionState,
  onCompanionExtensionReady,
} from "../../services/privcloudCompanion.service";

const SITE = "https://share.example.com";
const URL_FR = `${SITE}/resources/integrations`;
const URL_EN = `${SITE}/en/resources/integrations`;
const BETA_VERSION = "0.1.2";
const ANDROID_COMPANION_VERSION = "0.1.2";

type Connector = {
  id: string;
  label: string;
  status: "ready" | "beta";
  description: string;
  href: string;
  icon: JSX.Element;
  download?: boolean;
};

type Artifact = {
  id: string;
  label: string;
  description: string;
  href: string;
  icon: JSX.Element;
  openHref?: string;
};

const statusColor: Record<Connector["status"], string> = {
  ready: "teal",
  beta: "yellow",
};

const IntegrationsPage = () => {
  const intl = useIntl();
  const isFr = intl.locale?.startsWith("fr") ?? true;
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);
  const [extensionState, setExtensionState] =
    useState<CompanionExtensionState | null>(null);
  const [checking, setChecking] = useState(false);

  const title = isFr
    ? "Intégrations PrivCloud Companion"
    : "PrivCloud Companion Integrations";
  const description = isFr
    ? "Installer PrivCloud Companion, les connecteurs cloud/WebDAV et les connecteurs mail pour envoyer des fichiers chiffrés côté client."
    : "Install PrivCloud Companion, cloud/WebDAV connectors and mail connectors for client-side encrypted file transfer.";

  const refresh = async () => {
    setChecking(true);
    try {
      const [localHealth, extension] = await Promise.all([
        getBridgeHealth(),
        getCompanionExtensionState(),
      ]);
      setBridgeHealth(localHealth);
      setExtensionState(extension);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    refresh();
    return onCompanionExtensionReady(() => refresh());
  }, []);

  const connectors = useMemo<Connector[]>(
    () => [
      {
        id: "webdav",
        label: "WebDAV / Nextcloud",
        status: "ready",
        description: isFr
          ? "Connectez Nextcloud, ownCloud ou un NAS WebDAV depuis PrivCloud, sélectionnez les fichiers distants, puis chiffrez et envoyez côté client."
          : "Connect Nextcloud, ownCloud or a WebDAV NAS from PrivCloud, select remote files, then encrypt and upload client-side.",
        href: "/upload",
        icon: <TbCloud size={20} />,
      },
      {
        id: "mobile-cloud",
        label: "iOS / Android",
        status: "beta",
        description: isFr
          ? "Accès mobile au connecteur cloud interne depuis PrivCloud. L'import WebDAV direct fonctionne si le cloud autorise CORS ; un Companion mobile signé reste requis pour le même confort que desktop."
          : "Mobile access to PrivCloud's internal cloud connector. Direct WebDAV import works when the cloud allows CORS; a signed mobile Companion is still required for desktop-level reliability.",
        href: "/upload",
        icon: <TbCloud size={20} />,
        download: false,
      },
      {
        id: "browser",
        label: isFr ? "Extension navigateur" : "Browser extension",
        status: "beta",
        description: isFr
          ? "Build WebExtension bêta pour Chrome, Edge et Firefox. Publication store prévue."
          : "Beta WebExtension build for Chrome, Edge and Firefox. Store publication planned.",
        href: `/install/beta/privcloud-browser-extension-${BETA_VERSION}-beta.zip`,
        icon: <TbBrandChrome size={20} />,
      },
      {
        id: "thunderbird",
        label: "Thunderbird",
        status: "beta",
        description: isFr
          ? "MailExtension bêta au format XPI. Validation Thunderbird Add-ons prévue."
          : "Beta MailExtension as XPI. Thunderbird Add-ons review planned.",
        href: `/install/beta/privcloud-thunderbird-extension-${BETA_VERSION}-beta.xpi`,
        icon: <TbMail size={20} />,
      },
      {
        id: "outlook",
        label: "Outlook",
        status: "beta",
        description: isFr
          ? "Add-in Office.js bêta. Validation Microsoft 365 prévue."
          : "Beta Office.js add-in. Microsoft 365 validation planned.",
        href: `/install/beta/privcloud-outlook-addin-${BETA_VERSION}-beta.zip`,
        icon: <TbBrandWindows size={20} />,
      },
      {
        id: "gmail",
        label: "Gmail",
        status: "beta",
        description: isFr
          ? "Add-on Google Workspace bêta. Publication Marketplace prévue."
          : "Beta Google Workspace add-on. Marketplace publication planned.",
        href: `/install/beta/privcloud-google-workspace-addon-${BETA_VERSION}-beta.zip`,
        icon: <TbBrandGmail size={20} />,
      },
    ],
    [isFr],
  );

  const companionArtifacts = useMemo<Artifact[]>(
    () => [
      {
        id: "linux-dev",
        label: isFr ? "Script Linux dev" : "Linux dev script",
        description: isFr
          ? "Installateur utilisateur pour tests contrôlés. Requiert Node.js."
          : "User-level installer for controlled tests. Requires Node.js.",
        href: "/install/companion/install-linux-dev.sh",
        icon: <TbDownload size={20} />,
      },
      {
        id: "deb",
        label: "Debian / Ubuntu",
        description: isFr
          ? "Paquet .deb bêta non signé. Requiert Node.js."
          : "Unsigned beta .deb package. Requires Node.js.",
        href: `/install/beta/privcloud-companion_${BETA_VERSION}_beta_all.deb`,
        icon: <TbDownload size={20} />,
      },
      {
        id: "rpm",
        label: "Fedora / RHEL",
        description: isFr
          ? "Paquet .rpm bêta non signé. Requiert Node.js."
          : "Unsigned beta .rpm package. Requires Node.js.",
        href: `/install/beta/privcloud-companion-beta-${BETA_VERSION}-0.beta1.noarch.rpm`,
        icon: <TbDownload size={20} />,
      },
      {
        id: "linux-portable",
        label: "Linux portable",
        description: isFr
          ? "Archive portable bêta en attendant l'AppImage signée."
          : "Portable beta archive while signed AppImage is pending.",
        href: `/install/beta/privcloud-companion-${BETA_VERSION}-linux-portable-beta.tar.gz`,
        icon: <TbDownload size={20} />,
      },
      {
        id: "windows",
        label: "Windows",
        description: isFr
          ? "Archive portable bêta non signée en attendant le MSI Authenticode."
          : "Unsigned portable beta archive while Authenticode MSI is pending.",
        href: `/install/beta/privcloud-companion-${BETA_VERSION}-windows-portable-beta.zip`,
        icon: <TbBrandWindows size={20} />,
      },
      {
        id: "android",
        label: "Android",
        description: isFr
          ? "APK Companion Android bêta : lance un connecteur local 127.0.0.1 pour contourner CORS WebDAV/Nextcloud. L'alerte Android/Play Protect est normale en bêta."
          : "Android Companion beta APK: starts a local 127.0.0.1 connector to bypass WebDAV/Nextcloud CORS. Android/Play Protect warnings are normal in beta.",
        href: `/install/beta/privcloud-android-companion-${ANDROID_COMPANION_VERSION}-beta-debug.apk`,
        openHref: "privcloud-companion://start",
        icon: <TbBrandAndroid size={20} />,
      },
      {
        id: "macos",
        label: "macOS",
        description: isFr
          ? "Archive portable bêta non notarized en attendant le paquet Apple signé."
          : "Portable beta archive without notarization while signed Apple package is pending.",
        href: `/install/beta/privcloud-companion-${BETA_VERSION}-macos-portable-beta.zip`,
        icon: <TbBrandFirefox size={20} />,
      },
    ],
    [isFr],
  );

  const ldJson = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "PrivCloud Companion",
    applicationCategory: "SecurityApplication",
    operatingSystem: "Windows, macOS, Linux, Android, iOS, Chrome, Edge, Firefox",
    url: isFr ? URL_FR : URL_EN,
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
        <link rel="alternate" hrefLang="fr" href={URL_FR} />
        <link rel="alternate" hrefLang="en" href={URL_EN} />
      </Head>

      <Container size="lg" py="xl" px={0}>
        <Group gap="xs" mb="md" c="dimmed">
          <Anchor component={Link} href="/" size="sm" c="dimmed">
            {isFr ? "Accueil" : "Home"}
          </Anchor>
          <Text size="sm" c="dimmed">
            /
          </Text>
          <Anchor component={Link} href="/blog" size="sm" c="dimmed">
            {isFr ? "Ressources" : "Resources"}
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
              PrivCloud Companion
            </Badge>
            <Title order={1} fz={{ base: 28, sm: 40 }} fw={900} c="bright">
              {title}
            </Title>
            <Text maw={760} c="dimmed" lh={1.7}>
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

        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mb="xl">
          <Card withBorder radius="md" p="md">
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
                        ? "Non détecté"
                        : "Not detected"}
                  </Text>
                </Stack>
              </Group>
              <Badge color={bridgeHealth ? "teal" : "yellow"} variant="light">
                {bridgeHealth ? (isFr ? "Prêt" : "Ready") : "Install"}
              </Badge>
            </Group>
          </Card>

          <Card withBorder radius="md" p="md">
            <Group justify="space-between" align="center">
              <Group gap="sm">
                <TbBrandFirefox size={22} />
                <Stack gap={2}>
                  <Text fw={700}>
                    {isFr ? "Extension navigateur" : "Browser extension"}
                  </Text>
                  <Text size="sm" c="dimmed">
                    {extensionState?.installed
                      ? isFr
                        ? "Détectée"
                        : "Detected"
                      : isFr
                        ? "Non détectée"
                        : "Not detected"}
                  </Text>
                </Stack>
              </Group>
              <Badge
                color={extensionState?.installed ? "teal" : "blue"}
                variant="light"
              >
                {extensionState?.installed ? (isFr ? "Prête" : "Ready") : "MV3"}
              </Badge>
            </Group>
          </Card>
        </SimpleGrid>

        <Alert
          color="yellow"
          variant="light"
          icon={<TbShieldCheck size={18} />}
          mb="xl"
        >
          <Stack gap="sm">
            <Text size="sm">
              {isFr
                ? "Les paquets et plugins ci-dessous sont des builds bêta non signés, non notarized et non encore validés par les stores. Ils sont fournis pour test contrôlé ; la publication signée suivra après validation des certificats et comptes développeur."
                : "The packages and plugins below are unsigned beta builds, not notarized and not store-reviewed yet. They are provided for controlled testing; signed publication will follow after certificates and developer accounts are validated."}
            </Text>
            <Group gap="xs">
              <Button
                component="a"
                href="/install/beta/checksums.sha256"
                size="compact-sm"
                variant="light"
                leftSection={<TbDownload size={14} />}
              >
                Checksums
              </Button>
              <Button
                component="a"
                href="/install/beta/artifacts.json"
                size="compact-sm"
                variant="light"
                leftSection={<TbExternalLink size={14} />}
              >
                Manifest
              </Button>
            </Group>
          </Stack>
        </Alert>

        <Title order={2} size="h3" mb="md" c="bright">
          PrivCloud Companion
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md" mb="xl">
          {companionArtifacts.map((artifact) => (
            <Card key={artifact.id} withBorder radius="md" p="md" h="100%">
              <Stack gap="sm" h="100%">
                <Group justify="space-between">
                  <Group gap="xs">
                    {artifact.icon}
                    <Text fw={700}>{artifact.label}</Text>
                  </Group>
                  <Badge color="yellow" variant="light">
                    beta
                  </Badge>
                </Group>
                <Text size="sm" c="dimmed" lh={1.6}>
                  {artifact.description}
                </Text>
                <Group mt="auto">
                  <Button
                    component="a"
                    href={artifact.href}
                    variant="light"
                    leftSection={<TbDownload size={16} />}
                    download
                    style={{ flex: artifact.openHref ? 0.7 : 1 }}
                  >
                    {isFr ? "Télécharger" : "Download"}
                  </Button>
                  {artifact.openHref && (
                    <Button
                      component="a"
                      href={artifact.openHref}
                      variant="filled"
                      style={{ flex: 0.3 }}
                    >
                      {isFr ? "Ouvrir" : "Open"}
                    </Button>
                  )}
                </Group>
                {artifact.id === "linux-dev" && (
                  <Code block>
                    curl -fsSL {SITE}/install/companion/install-linux-dev.sh |
                    sh
                  </Code>
                )}
              </Stack>
            </Card>
          ))}
        </SimpleGrid>

        <Title order={2} size="h3" mb="md" c="bright">
          {isFr ? "Connecteurs" : "Connectors"}
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {connectors.map((connector) => (
            <Card key={connector.id} withBorder radius="md" p="md" h="100%">
              <Stack gap="sm" h="100%">
                <Group justify="space-between">
                  <Group gap="xs">
                    {connector.icon}
                    <Text fw={700}>{connector.label}</Text>
                  </Group>
                  <Badge color={statusColor[connector.status]} variant="light">
                    {connector.status}
                  </Badge>
                </Group>
                <Text size="sm" c="dimmed" lh={1.6}>
                  {connector.description}
                </Text>
                <Button
                  component="a"
                  href={connector.href}
                  variant={connector.status === "ready" ? "filled" : "light"}
                  rightSection={<TbExternalLink size={16} />}
                  mt="auto"
                  download={connector.download ?? connector.status !== "ready"}
                >
                  {connector.status === "ready"
                    ? isFr
                      ? "Ouvrir"
                      : "Open"
                    : isFr
                      ? "Artefact"
                      : "Artifact"}
                </Button>
              </Stack>
            </Card>
          ))}
        </SimpleGrid>
      </Container>
    </>
  );
};

export default IntegrationsPage;
