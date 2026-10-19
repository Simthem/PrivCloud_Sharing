import { useMounted } from "@mantine/hooks";
import {
  Alert,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import { useRouter } from "next/router";
import { TbCheck, TbEyeCheck, TbX } from "react-icons/tb";
import Meta from "../../../components/Meta";
import InvitationAuthChoice from "../../../components/auth/InvitationAuthChoice";
import useUser from "../../../hooks/user.hook";
import useTranslate from "../../../hooks/useTranslate.hook";
import teamExternalService from "../../../services/teamExternal.service";

function Requirement({
  ok,
  label,
  action,
}: {
  ok: boolean;
  label: string;
  action?: React.ReactNode;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="sm" w="100%">
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
        <ThemeIcon
          size={22}
          radius="xl"
          color={ok ? "teal" : "orange"}
          variant="light"
        >
          {ok ? <TbCheck size={14} /> : <TbX size={14} />}
        </ThemeIcon>
        <Text size="sm" style={{ overflowWrap: "anywhere" }}>
          {label}
        </Text>
      </Group>
      {!ok && action}
    </Group>
  );
}

const ExternalInvitePage = () => {
  const router = useRouter();
  const t = useTranslate();
  const { user, refreshUser } = useUser();
  const token = Array.isArray(router.query.token)
    ? router.query.token[0]
    : router.query.token || "";

  const invitation = useQuery({
    queryKey: ["external-invitation", token],
    queryFn: () => teamExternalService.getInvitation(token),
    enabled: !!user && !!token,
    retry: false,
  });

  // Private, client-only page: keep the server HTML equal to the first render.
  const mounted = useMounted();

  const accept = useMutation({
    mutationFn: () => teamExternalService.acceptInvitation(token),
    onSuccess: async () => {
      await refreshUser();
      await router.push("/external");
    },
  });

  if (!mounted)
    return (
      <Center mt="xl">
        <Loader />
      </Center>
    );

  if (!user) {
    return (
      <Container size="sm" mt="xl" px={0}>
        <Paper withBorder p="xl" ta="center">
          <Stack align="center" gap="md">
            <TbEyeCheck size={48} />
            <Title order={3}>{t("external.invite.title")}</Title>
            <InvitationAuthChoice
              queryKey={`external:${token}`}
              loadAccount={() =>
                teamExternalService.getInvitationAccount(token)
              }
            />
          </Stack>
        </Paper>
      </Container>
    );
  }

  const data = invitation.data;
  const ready =
    !!data && data.emailMatches && data.totpEnabled && data.keysReady;

  return (
    <>
      <Meta title={t("external.invite.title")} noIndex />
      <Container size="sm" mt="xl" px={0}>
        <Paper withBorder p="xl">
          <Stack align="center" gap="md">
            <TbEyeCheck size={48} color="var(--mantine-color-grape-6)" />
            <Title order={3} ta="center">
              {t("external.invite.title")}
            </Title>
            {invitation.isLoading && (
              <Center>
                <Loader />
              </Center>
            )}
            {invitation.isError && (
              <Alert color="red" w="100%">
                {t("external.invite.invalid")}
              </Alert>
            )}
            {data && (
              <>
                <Text ta="center">
                  {t("external.invite.description", {
                    team: data.teamName,
                    date: dayjs(data.accessExpiresAt).format("LL"),
                  })}
                </Text>
                <Text size="sm" c="dimmed" ta="center">
                  {t("external.invite.viewOnly")}
                </Text>
                <Stack gap="sm" w="100%">
                  <Requirement
                    ok={data.emailMatches}
                    label={t("external.invite.requirement.email", {
                      email: data.email,
                    })}
                  />
                  <Requirement
                    ok={data.totpEnabled}
                    label={t("external.invite.requirement.totp")}
                    action={
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => router.push("/account")}
                      >
                        {t("external.invite.enable")}
                      </Button>
                    }
                  />
                  <Requirement
                    ok={data.keysReady}
                    label={t("external.invite.requirement.keys")}
                    action={
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() =>
                          router.push("/account#e2e-encryption-settings")
                        }
                      >
                        {t("external.invite.enable")}
                      </Button>
                    }
                  />
                </Stack>
                {accept.isError && (
                  <Alert color="red" w="100%">
                    {t("external.invite.error")}
                  </Alert>
                )}
                <Button
                  size="md"
                  disabled={!ready}
                  loading={accept.isPending}
                  onClick={() => accept.mutate()}
                >
                  {t("external.invite.accept")}
                </Button>
              </>
            )}
          </Stack>
        </Paper>
      </Container>
    </>
  );
};

export default ExternalInvitePage;
