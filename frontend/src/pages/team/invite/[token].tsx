import { useRouter } from "next/router";
import { useMutation } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { useIntl } from "react-intl";
import {
  Alert,
  Button,
  Container,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { TbCheck, TbLock, TbUsersGroup } from "react-icons/tb";
import Meta from "../../../components/Meta";
import teamService from "../../../services/team.service";
import useUser from "../../../hooks/user.hook";
import {
  extractTeamKeyFromHash,
  importKeyFromBase64,
  getUserKey,
  wrapReverseShareKey,
} from "../../../utils/crypto.util";

const AcceptInvitePage = () => {
  const router = useRouter();
  const intl = useIntl();
  const { token } = router.query;
  const tokenStr = Array.isArray(token) ? token[0] : token || "";
  const { user, refreshUser } = useUser();
  const [accepted, setAccepted] = useState(false);

  // Detect if the team uses E2E (invitation URL contains #key=...)
  const teamHasE2E = useMemo(() => {
    try {
      return !!extractTeamKeyFromHash();
    } catch {
      return false;
    }
  }, []);

  // Check if user has their personal encryption key
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const userHasKey = useMemo(() => !!getUserKey(), [user]);

  // If team uses E2E but user has no personal key, block acceptance
  const needsKeyGeneration = teamHasE2E && !userHasKey;

  const acceptMutation = useMutation({
    mutationFn: async () => {
      // If the URL fragment contains a team key, wrap it with user's master key
      let wrappedTeamKey: string | undefined;
      try {
        const teamKeyB64 = extractTeamKeyFromHash();
        const userKeyB64 = getUserKey();
        if (teamKeyB64 && userKeyB64) {
          const teamKey = await importKeyFromBase64(teamKeyB64);
          const masterKey = await importKeyFromBase64(userKeyB64);
          wrappedTeamKey = await wrapReverseShareKey(teamKey, masterKey);
        }
      } catch (e) {
        console.warn("[E2E] Failed to wrap team key during invite accept:", e);
      }
      return teamService.acceptInvitation(tokenStr, wrappedTeamKey);
    },
    onSuccess: async (data) => {
      // If no wrappedTeamKey was sent but encryptedTeamKey exists in invitation,
      // try to resolve it (future: HKDF from token approach)
      if (data.encryptedTeamKey && !extractTeamKeyFromHash()) {
        // For now, the encryptedTeamKey is only usable if we implement
        // server-side key transport. The primary path is URL fragment.
        console.info("[E2E] Invitation has encryptedTeamKey but no fragment key");
      }
      // Refresh user context so hasTeamMembership is up-to-date before navigating
      await refreshUser();
      setAccepted(true);
      setTimeout(() => router.push(`/team/${data.teamId}`), 2000);
    },
  });

  if (!tokenStr) {
    return (
      <Container size="sm" mt="xl" px={0}>
        <Alert color="red">{intl.formatMessage({ id: "team.invite.invalid-link" })}</Alert>
      </Container>
    );
  }

  if (!user) {
    return (
      <Container size="sm" mt="xl" px={0}>
        <Paper withBorder p="xl" ta="center">
          <Stack align="center" gap="md">
            <TbUsersGroup size={48} />
            <Title order={3}>{intl.formatMessage({ id: "team.invite.title" })}</Title>
            <Text c="dimmed">
              {intl.formatMessage({ id: "team.invite.login-required" })}
            </Text>
            <Button onClick={() => router.push(`/auth/signIn?redirect=/team/invite/${tokenStr}`)}>
              {intl.formatMessage({ id: "team.invite.login-button" })}
            </Button>
          </Stack>
        </Paper>
      </Container>
    );
  }

  if (accepted) {
    return (
      <Container size="sm" mt="xl" px={0}>
        <Paper withBorder p="xl" ta="center">
          <Stack align="center" gap="md">
            <TbCheck size={64} color="var(--mantine-color-green-6)" />
            <Title order={3}>{intl.formatMessage({ id: "team.invite.accepted-title" })}</Title>
            <Text c="dimmed">{intl.formatMessage({ id: "team.invite.accepted-redirect" })}</Text>
          </Stack>
        </Paper>
      </Container>
    );
  }

  return (
    <>
      <Meta title={intl.formatMessage({ id: "team.invite.meta-title" })} />
      <Container size="sm" mt="xl" px={0}>
        <Paper withBorder p="xl" ta="center">
          <Stack align="center" gap="md">
            <TbUsersGroup size={48} color="var(--mantine-color-blue-6)" />
            <Title order={3}>{intl.formatMessage({ id: "team.invite.join-title" })}</Title>
            <Text c="dimmed">
              {intl.formatMessage({ id: "team.invite.join-description" })}
            </Text>

            {acceptMutation.isError && (
              <Alert color="red" w="100%">
                {(acceptMutation.error as any)?.response?.data?.message ||
                  intl.formatMessage({ id: "team.invite.error-generic" })}
              </Alert>
            )}

            {needsKeyGeneration && (
              <Alert color="orange" icon={<TbLock size={20} />} w="100%">
                <Text size="sm" fw={500} mb={4}>
                  {intl.formatMessage({ id: "team.invite.e2e-required-title" })}
                </Text>
                <Text size="sm" c="dimmed">
                  {intl.formatMessage({ id: "team.invite.e2e-required-description" })}
                </Text>
                <Button
                  variant="light"
                  color="orange"
                  size="xs"
                  mt="sm"
                  onClick={() => router.push(`/account#e2e?redirect=/team/invite/${tokenStr}`)}
                >
                  {intl.formatMessage({ id: "team.invite.e2e-setup-button" })}
                </Button>
              </Alert>
            )}

            <Button
              size="lg"
              onClick={() => acceptMutation.mutate()}
              loading={acceptMutation.isPending}
              disabled={needsKeyGeneration || acceptMutation.isSuccess || acceptMutation.isPending}
            >
              {intl.formatMessage({ id: "team.invite.accept-button" })}
            </Button>
          </Stack>
        </Paper>
      </Container>
    </>
  );
};

export default AcceptInvitePage;
