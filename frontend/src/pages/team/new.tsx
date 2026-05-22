import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/router";
import {
  Alert,
  Button,
  Container,
  Divider,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { TbUsersGroup } from "react-icons/tb";
import { useIntl } from "react-intl";
import Meta from "../../components/Meta";
import useUser from "../../hooks/user.hook";
import teamService from "../../services/team.service";
import toast from "../../utils/toast.util";

const NewTeamPage = () => {
  const router = useRouter();
  const { user } = useUser();
  const intl = useIntl();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (user === null) {
      router.replace("/auth/signIn?redirect=/team/new");
    } else if (user && user.plan !== "TEAM" && !user.isAdmin && !user.hasTeamMembership) {
      router.replace("/pricing");
    }
  }, [user]);

  const form = useForm({
    initialValues: {
      name: "",
      description: "",
    },
    validate: {
      name: (val: string) => {
        const trimmed = val.trim();
        if (trimmed.length < 2)
          return intl.formatMessage({ id: "team.create.error.name-too-short" });
        if (trimmed.length > 50)
          return intl.formatMessage({ id: "common.error.too-long" });
        return null;
      },
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      teamService.create(data),
    onSuccess: (team) => {
      toast.success(
        intl.formatMessage({ id: "team.create.success" }, { name: team.name }),
      );
      queryClient.invalidateQueries({ queryKey: ["teams.list"] });
      queryClient.invalidateQueries({ queryKey: ["teams.status"] });
      router.push(`/team/${team.id}`);
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.message ||
        intl.formatMessage({ id: "team.create.error.generic" });
      toast.error(msg);
    },
  });

  return (
    <>
      <Meta title={intl.formatMessage({ id: "team.create.modal.title" })} />
      <Container size="sm" mt="xl" mb="xl" px={0}>
        <Title order={2} mb="lg">
          <Group gap="xs">
            <TbUsersGroup size={28} />
            {intl.formatMessage({ id: "team.create.modal.title" })}
          </Group>
        </Title>

        <form
          onSubmit={form.onSubmit((values) =>
            createMutation.mutate({
              name: values.name.trim(),
              description: values.description?.trim() || undefined,
            }),
          )}
        >
          <Paper withBorder p="lg">
            <Stack gap="md">
              <TextInput
                label={intl.formatMessage({ id: "team.create.modal.name-label" })}
                description={intl.formatMessage({ id: "team.create.modal.name-hint" })}
                placeholder="Mon Équipe @Work"
                required
                {...form.getInputProps("name")}
              />

              <Textarea
                label={intl.formatMessage({ id: "team.create.modal.description-label" })}
                placeholder={intl.formatMessage({ id: "team.create.modal.description-placeholder" })}
                {...form.getInputProps("description")}
              />

              <Text size="xs" c="dimmed">
                {intl.formatMessage({ id: "team.create.modal.slug-auto" })}
              </Text>

              <Divider />

              <Alert variant="light" color="blue" title="Fonctionnalités Team" radius="md">
                <Stack gap={4}>
                  <Text size="sm">• Dossiers partagés avec gestion des accès</Text>
                  <Text size="sm">• Métriques et journal d'accès</Text>
                  <Text size="sm">• Rapports périodiques configurables</Text>
                </Stack>
              </Alert>

              <Group justify="flex-end">
                <Button variant="subtle" onClick={() => router.back()}>
                  {intl.formatMessage({ id: "common.button.cancel" })}
                </Button>
                <Button type="submit" loading={createMutation.isPending}>
                  {intl.formatMessage({ id: "team.create.modal.submit" })}
                </Button>
              </Group>
            </Stack>
          </Paper>
        </form>
      </Container>
    </>
  );
};

export default NewTeamPage;
