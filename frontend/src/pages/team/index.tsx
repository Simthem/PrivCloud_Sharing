import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/router";
import {
  Box,
  Button,
  Card,
  Container,
  Grid,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  TbFolder,
  TbPlus,
  TbUsers,
  TbUsersGroup,
} from "react-icons/tb";
import Meta from "../../components/Meta";
import useUser from "../../hooks/user.hook";
import teamService from "../../services/team.service";

const TeamsIndexPage = () => {
  const router = useRouter();
  const { user } = useUser();

  useEffect(() => {
    if (user === null) {
      router.replace("/auth/signIn?redirect=/team");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const { data: teams, isLoading } = useQuery({
    queryKey: ["teams.list"],
    queryFn: () => teamService.getMyTeams(),
  });

  return (
    <>
      <Meta title="Mes équipes" />
      <Container size="lg" mt="xl" px={0}>
        <Group justify="space-between" mb="lg">
          <Title order={2}>
            <Group gap="xs">
              <TbUsersGroup size={28} />
              Mes équipes
            </Group>
          </Title>
          <Button
            leftSection={<TbPlus size={16} />}
            onClick={() => router.push("/team/new")}
          >
            Créer une équipe
          </Button>
        </Group>

        {isLoading && (
          <Box ta="center" py="xl">
            <Loader />
          </Box>
        )}

        {!isLoading && (!teams || teams.length === 0) && (
          <Paper withBorder p="xl" ta="center">
            <Stack align="center" gap="md">
              <TbUsersGroup size={48} color="gray" />
              <Text c="dimmed" size="lg">
                Aucune équipe
              </Text>
              <Text c="dimmed" size="sm" maw={400}>
                Créez une équipe pour partager des fichiers et des dossiers avec
                vos collaborateurs.
              </Text>
              <Button
                leftSection={<TbPlus size={16} />}
                onClick={() => router.push("/team/new")}
              >
                Créer ma première équipe
              </Button>
            </Stack>
          </Paper>
        )}

        {teams && teams.length > 0 && (
          <Grid>
            {teams.map((team) => (
              <Grid.Col key={team.id} span={{ base: 12, sm: 6, md: 4 }}>
                <Card
                  shadow="sm"
                  padding="lg"
                  radius="md"
                  withBorder
                  style={{ cursor: "pointer", height: "100%", display: "flex", flexDirection: "column" }}
                  onClick={() => router.push(`/team/${team.id}`)}
                >
                  <Stack gap="sm" style={{ flex: 1 }}>
                    <Title order={4}>{team.name}</Title>

                    {team.description && (
                      <Text size="sm" c="dimmed" lineClamp={2}>
                        {team.description}
                      </Text>
                    )}

                    <Group gap="lg" mt="auto">
                      <Group gap={4}>
                        <TbUsers size={14} />
                        <Text size="sm">
                          {team.members?.length || 0} membres
                        </Text>
                      </Group>
                      <Group gap={4}>
                        <TbFolder size={14} />
                        <Text size="sm">
                          {(team as any)._count?.sharedFolders || 0} dossiers
                        </Text>
                      </Group>
                    </Group>
                  </Stack>
                </Card>
              </Grid.Col>
            ))}
          </Grid>
        )}
      </Container>
    </>
  );
};

export default TeamsIndexPage;
