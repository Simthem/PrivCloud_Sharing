import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  Select,
  Space,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { useEffect, useState } from "react";
import {
  TbLogin,
  TbPlus,
  TbSettings,
  TbTrash,
  TbUserPlus,
} from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import Meta from "../../components/Meta";
import useTranslate from "../../hooks/useTranslate.hook";
import api from "../../services/api.service";
import toast from "../../utils/toast.util";

interface AdminTeam {
  id: string;
  name: string;
  owner: { id: string; username: string; email: string };
  members: { id: string; role: string }[];
  maxMembers: number;
  createdAt: string;
  _count?: { sharedFolders: number; accessLogs: number };
}

interface PlatformUser {
  id: string;
  username: string;
  email: string;
}

const AdminTeams = () => {
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTeam, setSelectedTeam] = useState<AdminTeam | null>(null);

  // Create team modal
  const [createOpened, { open: openCreate, close: closeCreate }] =
    useDisclosure(false);
  const [createName, setCreateName] = useState("");
  const [createSlug, setCreateSlug] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createOwnerEmail, setCreateOwnerEmail] = useState<string | null>(null);
  const [createMaxMembers, setCreateMaxMembers] = useState<number>(3);

  // Add member modal
  const [addMemberOpened, { open: openAddMember, close: closeAddMember }] =
    useDisclosure(false);
  const [addUserEmail, setAddUserEmail] = useState<string | null>(null);
  const [addRole, setAddRole] = useState("MEMBER");

  // Max members modal
  const [maxMembersOpened, { open: openMaxMembers, close: closeMaxMembers }] =
    useDisclosure(false);
  const [newMaxMembers, setNewMaxMembers] = useState<number>(3);

  // Delete team modal
  const [deleteOpened, { open: openDelete, close: closeDelete }] =
    useDisclosure(false);
  const [deleteTeamTarget, setDeleteTeamTarget] = useState<AdminTeam | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

  const t = useTranslate();
  const isMobile = useMediaQuery("(max-width: 680px)");

  const fetchTeams = () => {
    setIsLoading(true);
    api
      .get("/teams/admin/all")
      .then((res) => {
        setTeams(res.data);
        setIsLoading(false);
      })
      .catch((err) => {
        toast.axiosError(err);
        setIsLoading(false);
      });
  };

  const fetchUsers = () => {
    api
      .get("/users")
      .then((res) => setUsers(res.data))
      .catch(() => {});
  };

  useEffect(() => {
    fetchTeams();
    fetchUsers();
  }, []);

  const userSelectData = users.map((u) => ({
    value: u.email,
    label: `${u.username} (${u.email})`,
  }));

  const handleCreateTeam = () => {
    if (!createName.trim() || !createSlug.trim() || !createOwnerEmail) return;
    api
      .post("/teams/admin/create", {
        name: createName.trim(),
        slug: createSlug.trim(),
        description: createDesc.trim() || undefined,
        ownerEmail: createOwnerEmail,
        maxMembers: createMaxMembers,
      })
      .then(() => {
        toast.success(t("admin.teams.created"));
        closeCreate();
        setCreateName("");
        setCreateSlug("");
        setCreateDesc("");
        setCreateOwnerEmail(null);
        setCreateMaxMembers(3);
        fetchTeams();
      })
      .catch(toast.axiosError);
  };

  const handleJoinTeam = (teamId: string) => {
    api
      .post(`/teams/admin/${teamId}/join`)
      .then(() => {
        toast.success(t("admin.teams.joined"));
        fetchTeams();
      })
      .catch(toast.axiosError);
  };

  const handleAddMember = () => {
    if (!selectedTeam || !addUserEmail) return;
    const user = users.find((u) => u.email === addUserEmail);
    if (!user) return;
    api
      .post(`/teams/admin/${selectedTeam.id}/add-member`, {
        userId: user.id,
        role: addRole,
      })
      .then(() => {
        toast.success(t("admin.teams.member-added"));
        closeAddMember();
        setAddUserEmail(null);
        fetchTeams();
      })
      .catch(toast.axiosError);
  };

  const _handleSetAdmin = (teamId: string, memberId: string) => {
    api
      .patch(`/teams/admin/${teamId}/members/${memberId}/set-admin`)
      .then(() => {
        toast.success(t("admin.teams.role-updated"));
        fetchTeams();
      })
      .catch(toast.axiosError);
  };

  const handleSetMaxMembers = () => {
    if (!selectedTeam) return;
    api
      .patch(`/teams/admin/${selectedTeam.id}/max-members`, {
        maxMembers: newMaxMembers,
      })
      .then(() => {
        toast.success(t("admin.teams.max-updated"));
        closeMaxMembers();
        fetchTeams();
      })
      .catch(toast.axiosError);
  };

  const handleDeleteTeam = () => {
    if (!deleteTeamTarget) return;
    if (deleteConfirmName.trim() !== deleteTeamTarget.name) {
      toast.error("Le nom saisi ne correspond pas au nom de l'équipe.");
      return;
    }
    setDeleteLoading(true);
    api
      .delete(`/teams/admin/${deleteTeamTarget.id}`)
      .then(() => {
        toast.success(`Équipe "${deleteTeamTarget.name}" supprimée.`);
        closeDelete();
        setDeleteTeamTarget(null);
        setDeleteConfirmName("");
        fetchTeams();
      })
      .catch(toast.axiosError)
      .finally(() => setDeleteLoading(false));
  };

  // Auto-generate slug from name
  const handleNameChange = (name: string) => {
    setCreateName(name);
    setCreateSlug(
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
    );
  };

  if (isLoading) {
    return <Loader />;
  }

  return (
    <>
      <Meta title={t("admin.teams.title")} />
      <Group justify="space-between" align="baseline" mb={20}>
        <Title mb={30} order={3}>
          <FormattedMessage id="admin.teams.title" />
        </Title>
        <Button leftSection={<TbPlus size={16} />} onClick={openCreate}>
          <FormattedMessage id="admin.teams.action.create" />
        </Button>
      </Group>

      {isMobile ? (
        <Stack gap="xs">
          {teams.map((team) => (
            <Paper key={team.id} withBorder p="sm">
              <Stack gap={4}>
                <Group justify="space-between" wrap="nowrap">
                  <Text fw={500} size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
                    {team.name}
                  </Text>
                  <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                    <Badge variant="light" color="blue" size="sm">
                      {team.members?.length || 0}/{team.maxMembers}
                    </Badge>
                  </Group>
                </Group>
                <Text size="xs" c="dimmed" truncate>
                  {team.owner?.email || "-"}
                </Text>
                <Group gap="xs" mt={4}>
                  <Tooltip label={t("admin.teams.action.join")}>
                    <ActionIcon variant="subtle" color="green" size="sm" onClick={() => handleJoinTeam(team.id)}>
                      <TbLogin size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("admin.teams.action.add-member")}>
                    <ActionIcon variant="subtle" color="blue" size="sm" onClick={() => { setSelectedTeam(team); openAddMember(); }}>
                      <TbUserPlus size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("admin.teams.action.max-members")}>
                    <ActionIcon variant="subtle" color="orange" size="sm" onClick={() => { setSelectedTeam(team); setNewMaxMembers(team.maxMembers); openMaxMembers(); }}>
                      <TbSettings size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Supprimer l'équipe">
                    <ActionIcon variant="subtle" color="red" size="sm" onClick={() => { setDeleteTeamTarget(team); setDeleteConfirmName(""); openDelete(); }}>
                      <TbTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Stack>
            </Paper>
          ))}
        </Stack>
      ) : (
      <div style={{ overflowX: "auto" }}>
      <Table striped highlightOnHover style={{ minWidth: 600 }}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>
              <FormattedMessage id="admin.teams.col.name" />
            </Table.Th>
            <Table.Th>
              <FormattedMessage id="admin.teams.col.owner" />
            </Table.Th>
            <Table.Th>
              <FormattedMessage id="admin.teams.col.members" />
            </Table.Th>
            <Table.Th>
              <FormattedMessage id="admin.teams.col.max" />
            </Table.Th>
            <Table.Th>
              <FormattedMessage id="admin.teams.col.actions" />
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {teams.map((team) => (
            <Table.Tr key={team.id}>
              <Table.Td>
                <Text fw={500}>{team.name}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{team.owner?.email || "-"}</Text>
              </Table.Td>
              <Table.Td>
                <Badge variant="light" color="blue">
                  {team.members?.length || 0}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Badge variant="light" color="gray">
                  {team.maxMembers}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Group gap="xs">
                  <Tooltip label={t("admin.teams.action.join")}>
                    <ActionIcon
                      variant="subtle"
                      color="green"
                      onClick={() => handleJoinTeam(team.id)}
                    >
                      <TbLogin size={18} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("admin.teams.action.add-member")}>
                    <ActionIcon
                      variant="subtle"
                      color="blue"
                      onClick={() => {
                        setSelectedTeam(team);
                        openAddMember();
                      }}
                    >
                      <TbUserPlus size={18} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={t("admin.teams.action.max-members")}>
                    <ActionIcon
                      variant="subtle"
                      color="orange"
                      onClick={() => {
                        setSelectedTeam(team);
                        setNewMaxMembers(team.maxMembers);
                        openMaxMembers();
                      }}
                    >
                      <TbSettings size={18} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Supprimer l'équipe">
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() => {
                        setDeleteTeamTarget(team);
                        setDeleteConfirmName("");
                        openDelete();
                      }}
                    >
                      <TbTrash size={18} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      </div>
      )}

      {teams.length === 0 && (
        <Text ta="center" c="dimmed" mt="xl">
          <FormattedMessage id="admin.teams.empty" />
        </Text>
      )}

      <Space h="xl" />

      {/* Create Team Modal */}
      <Modal
        opened={createOpened}
        onClose={closeCreate}
        title={t("admin.teams.modal.create-team")}
        size="md"
      >
        <Stack>
          <TextInput
            label={t("admin.teams.modal.team-name")}
            placeholder="Mon équipe"
            value={createName}
            onChange={(e) => handleNameChange(e.currentTarget.value)}
            required
          />
          <TextInput
            label={t("admin.teams.modal.team-slug")}
            placeholder="mon-equipe"
            value={createSlug}
            onChange={(e) => setCreateSlug(e.currentTarget.value)}
            description={t("admin.teams.modal.slug-hint")}
            required
          />
          <Textarea
            label={t("admin.teams.modal.team-description")}
            placeholder={t("admin.teams.modal.description-placeholder")}
            value={createDesc}
            onChange={(e) => setCreateDesc(e.currentTarget.value)}
            autosize
            minRows={2}
          />
          <Select
            label={t("admin.teams.modal.team-owner")}
            placeholder={t("admin.teams.select-user")}
            data={userSelectData}
            value={createOwnerEmail}
            onChange={setCreateOwnerEmail}
            searchable
            required
          />
          <NumberInput
            label={t("admin.teams.modal.max-members-label")}
            min={1}
            max={1000}
            value={createMaxMembers}
            onChange={(v) => setCreateMaxMembers(Number(v) || 3)}
          />
          <Button onClick={handleCreateTeam} fullWidth>
            <FormattedMessage id="admin.teams.modal.confirm-create" />
          </Button>
        </Stack>
      </Modal>

      {/* Add Member Modal */}
      <Modal
        opened={addMemberOpened}
        onClose={closeAddMember}
        title={t("admin.teams.modal.add-member")}
      >
        <Stack>
          <Select
            label={t("admin.teams.select-user")}
            placeholder={t("admin.teams.select-user")}
            data={userSelectData}
            value={addUserEmail}
            onChange={setAddUserEmail}
            searchable
          />
          <Select
            label={t("admin.teams.modal.role")}
            data={[
              { value: "MEMBER", label: "Member" },
              { value: "ADMIN", label: "Admin" },
              { value: "OWNER", label: "Owner" },
            ]}
            value={addRole}
            onChange={(v) => setAddRole(v || "MEMBER")}
          />
          <Button onClick={handleAddMember} fullWidth>
            <FormattedMessage id="admin.teams.modal.confirm-add" />
          </Button>
        </Stack>
      </Modal>

      {/* Max Members Modal */}
      <Modal
        opened={maxMembersOpened}
        onClose={closeMaxMembers}
        title={t("admin.teams.modal.max-members")}
      >
        <Stack>
          <NumberInput
            label={t("admin.teams.modal.max-members-label")}
            min={1}
            max={1000}
            value={newMaxMembers}
            onChange={(v) => setNewMaxMembers(Number(v) || 3)}
          />
          <Button onClick={handleSetMaxMembers} fullWidth>
            <FormattedMessage id="admin.teams.modal.confirm-max" />
          </Button>
        </Stack>
      </Modal>

      {/* Delete Team Modal */}
      <Modal
        opened={deleteOpened}
        onClose={closeDelete}
        title={`Supprimer l'équipe`}
        size="md"
      >
        <Stack>
          <Alert color="red" title="Action irréversible">
            Cette action supprimera définitivement l&apos;équipe{" "}
            <strong>{deleteTeamTarget?.name}</strong>, tous ses membres, dossiers
            et fichiers partagés. Cette opération est <strong>irréversible</strong>.
          </Alert>
          <TextInput
            label={`Tapez le nom de l'équipe pour confirmer`}
            placeholder={deleteTeamTarget?.name || ""}
            value={deleteConfirmName}
            onChange={(e) => setDeleteConfirmName(e.currentTarget.value)}
          />
          <Button
            color="red"
            leftSection={<TbTrash size={16} />}
            onClick={handleDeleteTeam}
            loading={deleteLoading}
            disabled={deleteConfirmName.trim() !== (deleteTeamTarget?.name || "")}
            fullWidth
          >
            Supprimer définitivement
          </Button>
        </Stack>
      </Modal>
    </>
  );
};

export default AdminTeams;
