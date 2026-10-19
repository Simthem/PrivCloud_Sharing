import { useMounted } from "@mantine/hooks";
import {
  Alert,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import Link from "next/link";
import { useRouter } from "next/router";
import { TbArrowLeft, TbLock } from "react-icons/tb";
import ExternalPreviewViewer from "../../components/external/ExternalPreviewViewer";
import useContractorKeys from "../../components/external/useContractorKeys";
import Meta from "../../components/Meta";
import useTranslate from "../../hooks/useTranslate.hook";
import teamExternalService from "../../services/teamExternal.service";
import {
  decryptExternalManifest,
  unwrapPreviewKey,
} from "../../utils/externalPreviewCrypto.util";

const ExternalPreviewPage = () => {
  const t = useTranslate();
  const router = useRouter();
  const previewId = Array.isArray(router.query.previewId)
    ? router.query.previewId[0]
    : router.query.previewId || "";
  const keys = useContractorKeys();
  // Private, client-only page: keep the server HTML equal to the first render.
  const mounted = useMounted();

  const preview = useQuery({
    queryKey: ["external-preview", previewId],
    queryFn: () => teamExternalService.getContractorPreview(previewId),
    enabled: !!previewId,
    retry: false,
    staleTime: Infinity,
  });
  const opened = useQuery({
    queryKey: ["external-preview-key", previewId, !!keys.data],
    enabled: !!preview.data && !!keys.data,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    queryFn: async () => {
      const key = await unwrapPreviewKey(preview.data!, keys.data!);
      const manifest = await decryptExternalManifest(
        key,
        preview.data!.id,
        preview.data!.encryptedManifest,
        preview.data!.pageCount,
      );
      return { key, manifest };
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
      <Meta
        title={opened.data?.manifest.title ?? t("external.list.title")}
        noIndex
      />
      <Container size="lg" mt="xl" px={0}>
        <Group mb="md">
          <Button
            component={Link}
            href="/external"
            variant="subtle"
            leftSection={<TbArrowLeft size={16} />}
          >
            {t("external.viewer.back")}
          </Button>
        </Group>

        {keys.locked && (
          <Alert color="orange" icon={<TbLock size={18} />}>
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

        {preview.isError && (
          <Alert color="red">{t("external.viewer.unavailable")}</Alert>
        )}
        {opened.isError && (
          <Alert color="red">{t("external.viewer.decryptError")}</Alert>
        )}
        {(preview.isLoading || opened.isLoading) && !keys.locked && (
          <Center mih={200}>
            <Loader />
          </Center>
        )}

        {preview.data && opened.data && (
          <Stack gap="md">
            <Stack gap={2}>
              <Title order={3} style={{ overflowWrap: "anywhere" }}>
                {opened.data.manifest.title}
              </Title>
              <Text size="sm" c="dimmed">
                {t("external.viewer.meta", {
                  team: preview.data.teamName,
                  date: dayjs(preview.data.accessExpiresAt).format("LL"),
                })}
              </Text>
            </Stack>
            <ExternalPreviewViewer
              previewId={preview.data.id}
              previewKey={opened.data.key}
              manifest={opened.data.manifest}
            />
          </Stack>
        )}
      </Container>
    </>
  );
};

export default ExternalPreviewPage;
