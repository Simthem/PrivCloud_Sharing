import {
  ActionIcon,
  Badge,
  Box,
  Card,
  Group,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useModals } from "@mantine/modals";
import { useMemo, useState } from "react";
import {
  TbArrowDown,
  TbArrowUp,
  TbCheck,
  TbEdit,
  TbMailCheck,
  TbTrash,
  TbUsersGroup,
} from "react-icons/tb";
import { FormattedMessage, useIntl } from "react-intl";
import useUser from "../../../hooks/user.hook";
import User from "../../../types/user.type";
import {
  DEFAULT_USER_SORT,
  sortUsers,
  UserSort,
  UserSortField,
} from "../../../utils/userSort.util";
import SortableHeader from "../SortableHeader";
import showUpdateUserModal from "./showUpdateUserModal";

const SORT_COLUMNS: {
  field: UserSortField;
  label: string;
  hint?: string;
}[] = [
  { field: "username", label: "admin.users.table.username" },
  { field: "email", label: "admin.users.table.email" },
  { field: "created", label: "admin.users.table.created" },
  { field: "admin", label: "admin.users.table.admin" },
];

const ManageUserTable = ({
  users: unsortedUsers,
  getUsers,
  deleteUser,
  isLoading,
}: {
  users: User[];
  getUsers: () => void;
  deleteUser: (_user: User) => void;
  isLoading: boolean;
}) => {
  const modals = useModals();
  const intl = useIntl();
  const { user: currentUser } = useUser();
  const isMobile = useMediaQuery("(max-width: 680px)");
  const [sort, setSort] = useState<UserSort>(DEFAULT_USER_SORT);
  const users = useMemo(
    () => sortUsers(unsortedUsers, sort),
    [unsortedUsers, sort],
  );

  const handleSort = (field: UserSortField) => {
    setSort((current) => ({
      field,
      direction:
        current.field === field && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  const fmtDate = (iso?: string | null) => {
    if (!iso) return "N/A";
    return intl.formatDate(iso, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const accessColor = () => "green";

  // Each action names the account it targets: in a dense list the buttons of
  // neighbouring rows must never be mistaken for one another.
  const editLabel = (user: User) =>
    intl.formatMessage(
      { id: "admin.users.edit.update.title" },
      { username: user.username },
    );
  const deleteLabel = (user: User) =>
    intl.formatMessage(
      { id: "admin.users.edit.delete.title" },
      { username: user.username },
    );

  const emailVerified = (user: User) =>
    ["EMAIL_LINK", "ADMINISTRATOR"].includes(
      user.emailVerificationSource || "",
    );

  const accountBadges = (user: User) => (
    <>
      {user.isLdap && <Badge size="xs">LDAP</Badge>}
      {user.totpVerified && (
        <Badge size="xs" color="teal" variant="light">
          2FA
        </Badge>
      )}
      {emailVerified(user) && (
        <Tooltip
          label={intl.formatMessage({ id: "admin.users.table.email-verified" })}
          withArrow
        >
          <Badge
            size="xs"
            color="green"
            variant="light"
            px={4}
            aria-label={intl.formatMessage({
              id: "admin.users.table.email-verified",
            })}
            style={{ flexShrink: 0 }}
          >
            <TbMailCheck size={12} style={{ display: "block" }} />
          </Badge>
        </Tooltip>
      )}
    </>
  );

  const teamLine = ({ teams }: User) =>
    !!teams?.length && (
      <Tooltip
        label={teams
          .map(
            ({ name, role }) =>
              `${name} (${intl.formatMessage({
                id: `team.role.${role.toLowerCase()}`,
              })})`,
          )
          .join(", ")}
        openDelay={300}
        multiline
        maw={320}
        withArrow
      >
        <Group gap={4} wrap="nowrap">
          <TbUsersGroup size={13} style={{ flexShrink: 0, opacity: 0.6 }} />
          <Text size="xs" c="dimmed" truncate="end">
            {teams.map(({ name }) => name).join(", ")}
          </Text>
        </Group>
      </Tooltip>
    );

  if (isMobile) {
    return (
      <Stack gap="sm">
        <Group gap="xs" wrap="nowrap">
          <Select
            style={{ flex: 1 }}
            aria-label={intl.formatMessage({ id: "admin.users.sort.label" })}
            allowDeselect={false}
            value={sort.field}
            data={SORT_COLUMNS.map(({ field, label }) => ({
              value: field,
              label: intl.formatMessage({ id: label }),
            }))}
            onChange={(field) =>
              field &&
              setSort({ field: field as UserSortField, direction: "asc" })
            }
          />
          <ActionIcon
            variant="light"
            size={36}
            aria-label={intl.formatMessage({
              id:
                sort.direction === "asc"
                  ? "admin.users.sort.ascending"
                  : "admin.users.sort.descending",
            })}
            onClick={() => handleSort(sort.field)}
          >
            {sort.direction === "asc" ? <TbArrowUp /> : <TbArrowDown />}
          </ActionIcon>
        </Group>
        {isLoading
          ? [...Array(5)].map((_, i) => (
              <Card key={i} withBorder padding="sm" radius="md">
                <Skeleton height={14} mb={6} />
                <Skeleton height={10} width="60%" />
              </Card>
            ))
          : users.map((user) => (
              <Card key={user.id} withBorder padding="sm" radius="md">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Box style={{ minWidth: 0, flex: 1 }}>
                    <Group gap={6} wrap="nowrap" mb={2}>
                      <Text size="sm" fw={600} truncate="end">
                        {user.username}
                      </Text>
                      {accountBadges(user)}
                      {user.isAdmin && (
                        <Badge
                          size="xs"
                          color="red"
                          variant="light"
                          style={{ flexShrink: 0 }}
                        >
                          Admin
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed" truncate="end">
                      {user.email}
                    </Text>
                    {teamLine(user)}
                    <Group gap="xs" wrap="wrap" mt={6}>
                      <Badge color={accessColor()} variant="light" size="sm">
                        Full access
                      </Badge>
                      <Text size="xs" c="dimmed">
                        {fmtDate(user.createdAt)}
                      </Text>
                    </Group>
                  </Box>
                  <Group gap="sm" wrap="nowrap">
                    {!user.isLdap && (
                      <ActionIcon
                        variant="light"
                        color="blue"
                        size={28}
                        aria-label={editLabel(user)}
                        onClick={() =>
                          showUpdateUserModal(
                            modals,
                            user,
                            getUsers,
                            user.id === currentUser?.id,
                          )
                        }
                      >
                        <TbEdit />
                      </ActionIcon>
                    )}
                    <ActionIcon
                      variant="light"
                      color="red"
                      size={28}
                      aria-label={deleteLabel(user)}
                      onClick={() => deleteUser(user)}
                    >
                      <TbTrash />
                    </ActionIcon>
                  </Group>
                </Group>
              </Card>
            ))}
      </Stack>
    );
  }

  return (
    <Box style={{ display: "block", overflowX: "auto" }}>
      <Table
        verticalSpacing="sm"
        horizontalSpacing="xs"
        highlightOnHover
        styles={{ th: { whiteSpace: "nowrap" } }}
      >
        <Table.Thead>
          <Table.Tr>
            {SORT_COLUMNS.map(({ field, label, hint }) => (
              <Table.Th
                key={field}
                style={{ textAlign: "left" }}
                aria-sort={
                  sort.field !== field
                    ? "none"
                    : sort.direction === "asc"
                      ? "ascending"
                      : "descending"
                }
              >
                <Tooltip
                  label={hint && intl.formatMessage({ id: hint })}
                  disabled={!hint}
                  withArrow
                >
                  <Box component="span" style={{ display: "inline-flex" }}>
                    <SortableHeader
                      field={field}
                      currentField={sort.field}
                      currentDir={sort.direction}
                      onSort={handleSort}
                    >
                      <FormattedMessage id={label} />
                    </SortableHeader>
                  </Box>
                </Tooltip>
              </Table.Th>
            ))}
            <Table.Th style={{ width: 1 }}></Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {isLoading
            ? skeletonRows
            : users.map((user) => (
                <Table.Tr key={user.id}>
                  <Table.Td
                    style={{ whiteSpace: "nowrap", overflowWrap: "normal" }}
                  >
                    {user.username}
                    {(user.isLdap ||
                      user.totpVerified ||
                      emailVerified(user)) && (
                      <Group gap={4} wrap="nowrap" mt={2}>
                        {accountBadges(user)}
                      </Group>
                    )}
                  </Table.Td>
                  <Table.Td style={{ maxWidth: 0, width: "100%" }}>
                    <Tooltip label={user.email} openDelay={300} withArrow>
                      <Text size="sm" truncate="end">
                        {user.email}
                      </Text>
                    </Tooltip>
                    {teamLine(user)}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" style={{ whiteSpace: "nowrap" }}>
                      {fmtDate(user.createdAt)}
                    </Text>
                  </Table.Td>
                  <Table.Td>{user.isAdmin && <TbCheck />}</Table.Td>
                  <Table.Td style={{ whiteSpace: "nowrap" }}>
                    {/* One row, never wrapped: a wrapped delete button would
                        sit next to the following user's edit button. */}
                    <Group justify="flex-end" gap="md" wrap="nowrap">
                      {user.isLdap ? null : (
                        <Tooltip label={editLabel(user)} withArrow>
                          <ActionIcon
                            variant="light"
                            color="blue"
                            size={28}
                            aria-label={editLabel(user)}
                            onClick={() =>
                              showUpdateUserModal(
                                modals,
                                user,
                                getUsers,
                                user.id === currentUser?.id,
                              )
                            }
                          >
                            <TbEdit />
                          </ActionIcon>
                        </Tooltip>
                      )}
                      <Tooltip label={deleteLabel(user)} withArrow color="red">
                        <ActionIcon
                          variant="light"
                          color="red"
                          size={28}
                          aria-label={deleteLabel(user)}
                          onClick={() => deleteUser(user)}
                        >
                          <TbTrash />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
};

const skeletonRows = [...Array(10)].map((v, i) => (
  <Table.Tr key={i}>
    <Table.Td>
      <Skeleton key={i} height={20} />
    </Table.Td>
    <Table.Td>
      <Skeleton key={i} height={20} />
    </Table.Td>
    <Table.Td>
      <Skeleton key={i} height={20} />
    </Table.Td>
    <Table.Td>
      <Skeleton key={i} height={20} />
    </Table.Td>
    <Table.Td>
      <Skeleton key={i} height={20} />
    </Table.Td>
    <Table.Td>
      <Skeleton key={i} height={20} />
    </Table.Td>
    <Table.Td>
      <Skeleton key={i} height={20} />
    </Table.Td>
    <Table.Td>
      <Skeleton key={i} height={20} />
    </Table.Td>
  </Table.Tr>
));

export default ManageUserTable;
