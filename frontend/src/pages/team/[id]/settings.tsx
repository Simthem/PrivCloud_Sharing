import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Container,
  Divider,
  Group,
  Loader,
  Modal,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
  Box,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  TbAlertTriangle,
  TbArrowLeft,
  TbDeviceFloppy,
  TbFolder,
  TbShieldCheck,
  TbTrash,
  TbUser,
  TbUserMinus,
  TbUsers,
} from "react-icons/tb";
import Meta from "../../../components/Meta";
import teamService from "../../../services/team.service";
import useUser from "../../../hooks/user.hook";
import toast from "../../../utils/toast.util";

const TeamSettings = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id: teamId } = router.query;
  const teamIdStr = Array.isArray(teamId) ? teamId[0] : teamId || "";
  const user = useUser();
  const isMobile = useMediaQuery("(max-width: 680px)");

  const { data: team, isLoading } = useQuery({
    queryKey: ["team", teamIdStr],
    queryFn: () => teamService.getTeam(teamIdStr),
    enabled: !!teamIdStr,
  });

  // Determine current user role
  const myRole = useMemo(() => {
    if (!team?.members || !user.user) return null;
    const me = team.members.find((m: any) => m.user?.id === user.user!.id);
    return me?.role ?? null;
  }, [team, user.user]);
  const isTeamAdmin = myRole === "OWNER" || myRole === "ADMIN";

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [selectedMember, setSelectedMember] = useState<any>(null);
  const [memberModalOpen, setMemberModalOpen] = useState(false);
  const [removeMemberConfirm, setRemoveMemberConfirm] = useState(false);

  // Fetch folder access for selected member
  const { data: memberAccess, isLoading: memberAccessLoading } = useQuery({
    queryKey: ["team.memberAccess", teamIdStr, selectedMember?.id],
    queryFn: () => teamService.getMemberFolderAccess(teamIdStr, selectedMember?.id),
    enabled: !!teamIdStr && !!selectedMember?.id && memberModalOpen,
  });

  useEffect(() => {
    if (team) {
      setName(team.name || "");
      setDescription(team.description || "");
    }
  }, [team]);

  const updateMutation = useMutation({
    mutationFn: () => teamService.updateTeam(teamIdStr, { name, description }),
    onSuccess: () => {
      toast.success("Équipe mise à jour");
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.message || "Erreur lors de la mise à jour"),
  });

  const deleteMutation = useMutation({
    mutationFn: (confirmationName: string) =>
      teamService.deleteTeam(teamIdStr, confirmationName),
    onSuccess: () => {
      toast.success("Équipe supprimée définitivement");
      router.push("/account");
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.message || "Impossible de supprimer l'équipe"),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (memberId: string) =>
      teamService.removeMember(teamIdStr, memberId),
    onSuccess: () => {
      toast.success("Membre retiré de l'équipe");
      setMemberModalOpen(false);
      setSelectedMember(null);
      setRemoveMemberConfirm(false);
      queryClient.invalidateQueries({ queryKey: ["team", teamIdStr] });
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.message || "Erreur"),
  });

  const setFolderAccessMutation = useMutation({
    mutationFn: ({ folderId, permission }: { folderId: string; permission: string }) =>
      teamService.setFolderAccess(teamIdStr, folderId, {
        memberId: selectedMember?.id,
        permission,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["team.memberAccess", teamIdStr, selectedMember?.id],
      });
      toast.success("Permission mise à jour");
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.message || "Erreur"),
  });

  const removeFolderAccessMutation = useMutation({
    mutationFn: (folderId: string) =>
      teamService.removeFolderAccess(teamIdStr, folderId, selectedMember?.id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["team.memberAccess", teamIdStr, selectedMember?.id],
      });
      toast.success("Règle d'accès supprimée");
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.message || "Erreur"),
  });

  const leaveTeamMutation = useMutation({
    mutationFn: () => teamService.leaveTeam(teamIdStr),
    onSuccess: () => {
      toast.success("Vous avez quitté l'équipe");
      router.push("/account");
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.message || "Impossible de quitter l'équipe"),
  });

  if (isLoading || !teamIdStr) {
    return (
      <Container size="sm" mt="xl" px={0}>
        <Box ta="center" py="xl">
          <Loader size="lg" />
        </Box>
      </Container>
    );
  }

  if (!team) {
    return (
      <Container size="sm" mt="xl" px={0}>
        <Alert color="red">Équipe non trouvée</Alert>
      </Container>
    );
  }

  if (!isTeamAdmin && myRole !== "MEMBER") {
    return (
      <Container size="sm" mt="xl" px={0}>
        <Alert color="orange">
          Vous n&apos;avez pas les permissions pour accéder aux paramètres de
          cette équipe.
        </Alert>
      </Container>
    );
  }

  const permissionOptions = [
    { value: "NONE", label: "Accès interdit" },
    { value: "READ", label: "Lecture seule" },
    { value: "WRITE", label: "Lecture + Écriture" },
    { value: "ADMIN", label: "Admin" },
  ];

  const permissionBadge = (perm: string | null) => {
    if (!perm) return <Badge size="sm" variant="light" color="gray">Par défaut</Badge>;
    const map: Record<string, { color: string; label: string }> = {
      NONE: { color: "red", label: "Interdit" },
      READ: { color: "blue", label: "Lecture" },
      WRITE: { color: "green", label: "Écriture" },
      ADMIN: { color: "violet", label: "Admin" },
    };
    const v = map[perm] || { color: "gray", label: perm };
    return <Badge size="sm" variant="filled" color={v.color}>{v.label}</Badge>;
  };

  return (
    <>
      <Meta title={`Paramètres - ${team.name}`} />
      <Container size="sm" mt="xl" mb="xl" px={0}>
        <Group mb="lg">
          <Button
            variant="subtle"
            leftSection={<TbArrowLeft size={16} />}
            onClick={() => router.push(`/team/${teamIdStr}`)}
          >
            Retour
          </Button>
        </Group>

        <Title order={2} mb="lg">
          Paramètres de l&apos;équipe
        </Title>

        <Paper withBorder p="lg" mb="lg">
          <Stack>
            <TextInput
              label="Nom de l'équipe"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              maxLength={50}
              required
            />
            <Textarea
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              maxLength={200}
              autosize
              minRows={2}
            />
            <Group justify="flex-end">
              <Button
                leftSection={<TbDeviceFloppy size={16} />}
                onClick={() => updateMutation.mutate()}
                loading={updateMutation.isPending}
                disabled={!name.trim()}
              >
                Enregistrer
              </Button>
            </Group>
          </Stack>
        </Paper>

        {/* ───── Section membres (admins uniquement) ───── */}
        {isTeamAdmin && (
          <>
            <Divider my="lg" />
            <Paper withBorder p="lg" mb="lg">
              <Group mb="md">
                <TbUsers size={20} />
                <Title order={4}>Gestion des membres</Title>
              </Group>
              <Text size="sm" c="dimmed" mb="md">
                Cliquez sur un membre pour gérer ses accès aux dossiers ou le
                retirer de l&apos;équipe.
              </Text>

              {isMobile ? (
                <Stack gap="xs">
                  {team.members
                    ?.filter((m: any) => m.isActive !== false)
                    ?.map((member: any) => (
                      <Paper
                        key={member.id}
                        withBorder
                        p="sm"
                        style={{
                          cursor: member.role !== "OWNER" ? "pointer" : undefined,
                        }}
                        onClick={() => {
                          if (member.role === "OWNER") return;
                          setSelectedMember(member);
                          setRemoveMemberConfirm(false);
                          setMemberModalOpen(true);
                        }}
                      >
                        <Group justify="space-between" wrap="nowrap">
                          <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                            <Group gap="xs" wrap="nowrap">
                              <TbUser size={14} style={{ flexShrink: 0 }} />
                              <Text size="sm" fw={500} truncate>
                                {member.user?.username || "-"}
                              </Text>
                            </Group>
                            <Text size="xs" c="dimmed" truncate>
                              {member.user?.email}
                            </Text>
                          </Stack>
                          <Badge
                            variant="light"
                            color={
                              member.role === "OWNER"
                                ? "violet"
                                : member.role === "ADMIN"
                                  ? "blue"
                                  : "gray"
                            }
                            style={{ flexShrink: 0 }}
                          >
                            {member.role === "OWNER"
                              ? "Propriétaire"
                              : member.role === "ADMIN"
                                ? "Admin"
                                : "Membre"}
                          </Badge>
                        </Group>
                      </Paper>
                    ))}
                </Stack>
              ) : (
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Nom</Table.Th>
                    <Table.Th>Email</Table.Th>
                    <Table.Th>Rôle</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {team.members
                    ?.filter((m: any) => m.isActive !== false)
                    ?.map((member: any) => (
                      <Table.Tr
                        key={member.id}
                        style={{
                          cursor:
                            member.role !== "OWNER" ? "pointer" : undefined,
                        }}
                        onClick={() => {
                          if (member.role === "OWNER") return;
                          setSelectedMember(member);
                          setRemoveMemberConfirm(false);
                          setMemberModalOpen(true);
                        }}
                      >
                        <Table.Td>
                          <Group gap="xs">
                            <TbUser size={14} />
                            <Text size="sm" fw={500}>
                              {member.user?.username || "-"}
                            </Text>
                          </Group>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{member.user?.email}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge
                            variant="light"
                            color={
                              member.role === "OWNER"
                                ? "violet"
                                : member.role === "ADMIN"
                                  ? "blue"
                                  : "gray"
                            }
                          >
                            {member.role === "OWNER"
                              ? "Propriétaire"
                              : member.role === "ADMIN"
                                ? "Admin"
                                : "Membre"}
                          </Badge>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                </Table.Tbody>
              </Table>
              )}
            </Paper>
          </>
        )}

        {/* ───── Quitter l'équipe (membres non-owner) ───── */}
        {myRole && myRole !== "OWNER" && (
          <>
            <Divider my="lg" />
            <Paper withBorder p="lg" mb="lg" style={{ borderColor: "var(--mantine-color-orange-4)" }}>
              <Stack>
                <Title order={4} c="orange">
                  Quitter l&apos;équipe
                </Title>
                <Text size="sm" c="dimmed">
                  En quittant l&apos;équipe, vous perdrez l&apos;accès à tous
                  les dossiers et fichiers partagés. Vos règles d&apos;accès
                  seront supprimées.
                </Text>
                <Group justify="flex-end">
                  <Button
                    color="orange"
                    variant="outline"
                    leftSection={<TbUserMinus size={16} />}
                    onClick={() => leaveTeamMutation.mutate()}
                    loading={leaveTeamMutation.isPending}
                  >
                    Quitter l&apos;équipe
                  </Button>
                </Group>
              </Stack>
            </Paper>
          </>
        )}

        {myRole === "OWNER" && (
          <>
            <Divider my="lg" />
            <Paper withBorder p="lg" style={{ borderColor: "var(--mantine-color-red-4)" }}>
              <Stack>
                <Title order={4} c="red">
                  Zone dangereuse
                </Title>
                <Text size="sm" c="dimmed">
                  La suppression de l&apos;équipe est{" "}
                  <Text span fw={700} c="red">
                    définitive et irréversible
                  </Text>
                  . Tous les dossiers, fichiers partagés et données associées
                  seront supprimés de façon permanente.
                </Text>
                <Group justify="flex-end">
                  <Button
                    color="red"
                    variant="outline"
                    leftSection={<TbTrash size={16} />}
                    onClick={() => {
                      setDeleteConfirmInput("");
                      setDeleteModalOpen(true);
                    }}
                  >
                    Supprimer l&apos;équipe
                  </Button>
                </Group>
              </Stack>
            </Paper>

            {/* Modal de confirmation de suppression */}
            <Modal
              opened={deleteModalOpen}
              onClose={() => setDeleteModalOpen(false)}
              title={
                <Group gap="xs">
                  <TbAlertTriangle size={20} color="var(--mantine-color-red-6)" />
                  <Text fw={700} c="red">
                    Suppression irréversible
                  </Text>
                </Group>
              }
              centered
            >
              <Stack gap="md">
                <Alert color="red" variant="light" icon={<TbAlertTriangle />}>
                  Cette action supprimera définitivement l&apos;équipe{" "}
                  <Text span fw={700}>
                    &laquo;{team.name}&raquo;
                  </Text>
                  , incluant :
                  <ul style={{ margin: "8px 0 0 0", paddingLeft: 16 }}>
                    <li>Tous les dossiers partagés</li>
                    <li>Tous les fichiers stockés</li>
                    <li>Tous les partages associés</li>
                    <li>Tous les membres et permissions</li>
                    <li>L&apos;historique d&apos;activité</li>
                  </ul>
                </Alert>

                <Text size="sm" fw={500}>
                  Pour confirmer, tapez le nom exact de l&apos;équipe :{" "}
                  <Text span ff="monospace" fw={700} c="red">
                    {team.name}
                  </Text>
                </Text>

                <TextInput
                  placeholder={team.name}
                  value={deleteConfirmInput}
                  onChange={(e) => setDeleteConfirmInput(e.currentTarget.value)}
                  error={
                    deleteConfirmInput.length > 0 &&
                    deleteConfirmInput !== team.name
                      ? "Le nom ne correspond pas"
                      : undefined
                  }
                  styles={{
                    input: { borderColor: "var(--mantine-color-red-4)" },
                  }}
                />

                <Group justify="flex-end" gap="sm">
                  <Button
                    variant="default"
                    onClick={() => setDeleteModalOpen(false)}
                  >
                    Annuler
                  </Button>
                  <Button
                    color="red"
                    leftSection={<TbTrash size={16} />}
                    disabled={deleteConfirmInput !== team.name}
                    loading={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(deleteConfirmInput)}
                  >
                    Supprimer définitivement
                  </Button>
                </Group>
              </Stack>
            </Modal>
          </>
        )}

        {/* ───── Modal gestion d'un membre ───── */}
        <Modal
          opened={memberModalOpen}
          onClose={() => {
            setMemberModalOpen(false);
            setSelectedMember(null);
            setRemoveMemberConfirm(false);
          }}
          title={
            <Group gap="xs">
              <TbShieldCheck size={20} />
              <Text fw={700}>
                {selectedMember?.user?.username || selectedMember?.user?.email || "Membre"}
              </Text>
            </Group>
          }
          size="lg"
          centered
        >
          {selectedMember && (
            <Stack gap="md">
              <Group gap="lg">
                <Text size="sm" c="dimmed">
                  Email : <Text span fw={500}>{selectedMember.user?.email}</Text>
                </Text>
                <Badge
                  variant="light"
                  color={selectedMember.role === "ADMIN" ? "blue" : "gray"}
                >
                  {selectedMember.role === "ADMIN" ? "Admin" : "Membre"}
                </Badge>
              </Group>

              <Divider />

              <Title order={5}>
                <Group gap="xs">
                  <TbFolder size={16} />
                  Accès aux dossiers
                </Group>
              </Title>

              {memberAccessLoading ? (
                <Box ta="center" py="md">
                  <Loader size="sm" />
                </Box>
              ) : memberAccess?.folders && memberAccess.folders.length > 0 ? (
                <Table striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Dossier</Table.Th>
                      <Table.Th>Permission actuelle</Table.Th>
                      <Table.Th>Modifier</Table.Th>
                      <Table.Th></Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {memberAccess.folders.map((folder) => (
                      <Table.Tr key={folder.id}>
                        <Table.Td>
                          <Group gap="xs">
                            <TbFolder
                              size={14}
                              color={folder.color || "var(--mantine-color-blue-6)"}
                            />
                            <Text size="sm">{folder.name}</Text>
                          </Group>
                        </Table.Td>
                        <Table.Td>{permissionBadge(folder.permission)}</Table.Td>
                        <Table.Td>
                          <Select
                            size="xs"
                            w={160}
                            placeholder="Définir..."
                            data={permissionOptions}
                            value={folder.permission || ""}
                            onChange={(val) => {
                              if (val) {
                                setFolderAccessMutation.mutate({
                                  folderId: folder.id,
                                  permission: val,
                                });
                              }
                            }}
                            clearable={false}
                          />
                        </Table.Td>
                        <Table.Td>
                          {folder.permission && (
                            <Tooltip label="Supprimer la règle (accès par défaut)">
                              <ActionIcon
                                variant="light"
                                color="gray"
                                size="sm"
                                onClick={() =>
                                  removeFolderAccessMutation.mutate(folder.id)
                                }
                              >
                                <TbTrash size={14} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              ) : (
                <Text size="sm" c="dimmed" ta="center" py="md">
                  Aucun dossier dans l&apos;équipe.
                </Text>
              )}

              <Text size="xs" c="dimmed">
                « Par défaut » : le membre a accès en lecture/écriture. Définir
                « Accès interdit » pour bloquer l&apos;accès à un dossier
                spécifique.
              </Text>

              <Divider />

              {/* Retirer le membre */}
              {!removeMemberConfirm ? (
                <Group justify="flex-end">
                  <Button
                    color="red"
                    variant="light"
                    leftSection={<TbUserMinus size={16} />}
                    onClick={() => setRemoveMemberConfirm(true)}
                  >
                    Retirer de l&apos;équipe
                  </Button>
                </Group>
              ) : (
                <Alert color="red" variant="light">
                  <Stack gap="sm">
                    <Text size="sm" fw={500}>
                      Confirmer le retrait de{" "}
                      <Text span fw={700}>
                        {selectedMember.user?.email}
                      </Text>{" "}
                      de l&apos;équipe ?
                    </Text>
                    <Group justify="flex-end" gap="sm">
                      <Button
                        variant="default"
                        size="xs"
                        onClick={() => setRemoveMemberConfirm(false)}
                      >
                        Annuler
                      </Button>
                      <Button
                        color="red"
                        size="xs"
                        leftSection={<TbTrash size={14} />}
                        loading={removeMemberMutation.isPending}
                        onClick={() =>
                          removeMemberMutation.mutate(selectedMember.id)
                        }
                      >
                        Confirmer le retrait
                      </Button>
                    </Group>
                  </Stack>
                </Alert>
              )}
            </Stack>
          )}
        </Modal>
      </Container>
    </>
  );
};

export default TeamSettings;
