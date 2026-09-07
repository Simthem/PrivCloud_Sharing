import { Badge, Button, Group, Space, Text, TextInput, Title } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { useEffect, useMemo, useState } from "react";
import { TbPlus, TbSearch } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import Meta from "../../components/Meta";
import ManageUserTable from "../../components/admin/users/ManageUserTable";
import showCreateUserModal from "../../components/admin/users/showCreateUserModal";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import userService from "../../services/user.service";
import User from "../../types/user.type";
import toast from "../../utils/toast.util";

const Users = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState("");

  const config = useConfig();
  const modals = useModals();
  const t = useTranslate();

  const filteredUsers = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return users;

    return users.filter(
      (user) =>
        user.username.toLocaleLowerCase().includes(query) ||
        user.email.toLocaleLowerCase().includes(query),
    );
  }, [search, users]);

  const getUsers = () => {
    setIsLoading(true);
    userService.list().then((users) => {
      setUsers(users);
      setIsLoading(false);
    });
  };

  const deleteUser = (user: User) => {
    modals.openConfirmModal({
      title: t("admin.users.edit.delete.title", {
        username: user.username,
      }),
      children: (
        <Text size="sm">
          <FormattedMessage id="admin.users.edit.delete.description" />
        </Text>
      ),
      labels: {
        confirm: t("common.button.delete"),
        cancel: t("common.button.cancel"),
      },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        userService
          .remove(user.id)
          .then(() => setUsers(users.filter((v) => v.id != user.id)))
          .catch(toast.axiosError);
      },
    });
  };

  useEffect(() => {
    getUsers();
  }, []);

  return (
    <>
      <Meta title={t("admin.users.title")} />
      <Group justify="space-between" align="baseline" mb={20}>
        <Group gap="sm" align="center">
          <Title order={3}>
            <FormattedMessage id="admin.users.title" />
          </Title>
          {!isLoading && (
            <Badge variant="light" size="lg">
              <FormattedMessage
                id="admin.users.total"
                values={{ count: users.length }}
              />
            </Badge>
          )}
        </Group>
        <Button
          onClick={() =>
            showCreateUserModal(modals, config.get("smtp.enabled"), getUsers)
          }
          leftSection={<TbPlus size={20} />}
        >
          <FormattedMessage id="common.button.create" />
        </Button>
      </Group>

      <TextInput
        mb="md"
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
        leftSection={<TbSearch size={18} />}
        placeholder={t("admin.users.search.placeholder")}
        aria-label={t("admin.users.search.placeholder")}
        maw={480}
      />
      {search.trim() && !isLoading && (
        <Text size="sm" c="dimmed" mb="sm">
          <FormattedMessage
            id="admin.users.search.results"
            values={{ count: filteredUsers.length }}
          />
        </Text>
      )}

      <ManageUserTable
        users={filteredUsers}
        getUsers={getUsers}
        deleteUser={deleteUser}
        isLoading={isLoading}
      />
      <Space h="xl" />
    </>
  );
};

export default Users;
