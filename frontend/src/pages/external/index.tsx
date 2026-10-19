import { useEffect } from "react";
import { buildSignInRedirectPath } from "../../utils/authRedirect.util";
import { useMounted } from "@mantine/hooks";
import {
  Alert,
  Badge,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import Link from "next/link";
import { useRouter } from "next/router";
import { TbEyeCheck, TbLock } from "react-icons/tb";
import useContractorKeys from "../../components/external/useContractorKeys";
import Meta from "../../components/Meta";
import useUser from "../../hooks/user.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import teamExternalService from "../../services/teamExternal.service";
import {
  decryptExternalManifest,
  unwrapPreviewKey,
} from "../../utils/externalPreviewCrypto.util";

const ExternalPreviewsPage = () => {
  const t = useTranslate();
  const router = useRouter();
  const { user, refreshUser } = useUser();
  const keys = useContractorKeys();
  // Private, client-only page: keep the server HTML equal to the first render.
  const mounted = useMounted();

  useEffect(() => {
    if (!mounted || user) return;
    let active = true;
    void refreshUser()
      .then((current) => {
        if (active && !current)
          void router.replace(buildSignInRedirectPath(router.asPath));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [mounted, user, refreshUser, router]);

  const status = useQuery({
    queryKey: ["external-status"],
    queryFn: () => teamExternalService.getContractorStatus(),
    enabled: !!user,
  });
  const previews = useQuery({
    queryKey: ["external-previews"],
    queryFn: () => teamExternalService.listContractorPreviews(),
    enabled: !!user && !!status.data?.totpEnabled,
  });
  const titles = useQuery({
    queryKey: ["external-titles", previews.data?.map((p) => p.id).join(",")],
    enabled: !!previews.data && !!keys.data,
    queryFn: async () => {
      const result: Record<string, string> = {};
      for (const preview of previews.data!) {
        try {
          const key = await unwrapPreviewKey(preview, keys.data!);
          const manifest = await decryptExternalManifest(
            key,
            preview.id,
            preview.encryptedManifest,
            preview.pageCount,
          );
          result[preview.id] = manifest.title;
        } catch {
          // Shown as unreadable below.
        }
      }
      return result;
    },
  });

  if (!mounted)
    return (
      <Center mt="xl">
        <Loader />
      </Center>
    );

  return (
    <>
      <Meta title={t("external.list.title")} noIndex />
      <Container size="md" mt="xl" px={0}>
        <Group mb="lg" gap="xs">
          <TbEyeCheck size={26} />
          <Title order={2}>{t("external.list.title")}</Title>
        </Group>
        <Text c="dimmed" mb="lg">
          {t("external.list.description")}
        </Text>

        {status.data && status.data.seats.length > 0 && (
          <Stack gap={4} mb="lg">
            {status.data.seats.map((seat, index) => (
              <Text size="sm" key={index}>
                {t("external.list.access", {
                  team: seat.teamName,
                  date: dayjs(seat.accessExpiresAt).format("LL"),
                })}
              </Text>
            ))}
          </Stack>
        )}

        {status.data && !status.data.totpEnabled && (
          <Alert color="orange" icon={<TbLock size={18} />} mb="lg">
            <Text size="sm" mb="xs">
              {t("external.list.totpRequired")}
            </Text>
            <Button
              size="xs"
              variant="light"
              onClick={() => router.push("/account")}
            >
              {t("external.invite.enable")}
            </Button>
          </Alert>
        )}

        {keys.locked && (
          <Alert color="orange" icon={<TbLock size={18} />} mb="lg">
            <Text size="sm" mb="xs">
              {t("external.list.keyLocked")}
            </Text>
            <Button
              size="xs"
              variant="light"
              onClick={() => router.push("/account#e2e-encryption-settings")}
            >
              {t("external.list.unlock")}
            </Button>
          </Alert>
        )}

        {(status.isLoading || previews.isLoading) && (
          <Center>
            <Loader />
          </Center>
        )}

        {status.data?.seats.length === 0 && (
          <Alert color="gray">{t("external.list.noAccess")}</Alert>
        )}

        {previews.data &&
          previews.data.length === 0 &&
          status.data?.seats.length !== 0 && (
            <Alert color="gray">{t("external.list.empty")}</Alert>
          )}

        <Stack gap="sm">
          {previews.data?.map((preview) => (
            <Paper key={preview.id} withBorder p="md">
              <Group justify="space-between" wrap="wrap" gap="sm">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Text fw={600} style={{ overflowWrap: "anywhere" }}>
                    {titles.data?.[preview.id] ??
                      (keys.locked || titles.isLoading
                        ? t("external.list.encryptedTitle")
                        : t("external.list.unreadable"))}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t("external.list.meta", {
                      team: preview.teamName,
                      date: dayjs(preview.createdAt).format("L"),
                      pages: preview.pageCount,
                    })}
                  </Text>
                </Stack>
                <Group gap="xs">
                  <Badge variant="light" color="grape">
                    {t("external.list.viewOnly")}
                  </Badge>
                  <Button
                    component={Link}
                    href={`/external/${preview.id}`}
                    size="xs"
                    disabled={keys.locked}
                  >
                    {t("external.list.open")}
                  </Button>
                </Group>
              </Group>
            </Paper>
          ))}
        </Stack>
      </Container>
    </>
  );
};

export default ExternalPreviewsPage;
