import {
  ActionIcon,
  Badge,
  Box,
  Card,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useModals } from "@mantine/modals";
import { TbCheck, TbEdit, TbTrash } from "react-icons/tb";
import { FormattedMessage, useIntl } from "react-intl";
import User from "../../../types/user.type";
import showUpdateUserModal from "./showUpdateUserModal";

const ManageUserTable = ({
  users,
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
  const isMobile = useMediaQuery("(max-width: 680px)");

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

  if (isMobile) {
    return (
      <Stack gap="sm">
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
                      <Text size="sm" fw={600} lineClamp={1}>
                        {user.username}
                      </Text>
                      {user.isLdap && <Badge size="xs">LDAP</Badge>}
                      {user.totpVerified && (
                        <Badge size="xs" color="teal" variant="light">
                          2FA
                        </Badge>
                      )}
                      {["EMAIL_LINK", "ADMINISTRATOR"].includes(
                        user.emailVerificationSource || "",
                      ) && (
                        <Badge size="xs" color="green" variant="light">
                          <FormattedMessage id="admin.users.table.email-verified" />
                        </Badge>
                      )}
                      {user.isAdmin && (
                        <Badge size="xs" color="red" variant="light" style={{ flexShrink: 0 }}>
                          Admin
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed" lineClamp={1} mb={6}>
                      {user.email}
                    </Text>
                    <Group gap="xs" wrap="wrap">
                      <Badge color={accessColor()} variant="light" size="sm">
                        Full access
                      </Badge>
                      <Text size="xs" c="dimmed">{fmtDate(user.createdAt)}</Text>
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
                          showUpdateUserModal(modals, user, getUsers)
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
      <Table verticalSpacing="sm" highlightOnHover>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>
              <FormattedMessage id="admin.users.table.username" />
            </th>
            <th style={{ textAlign: "left" }}>
              <FormattedMessage id="admin.users.table.email" />
            </th>
            <th style={{ textAlign: "left" }}>
              <FormattedMessage id="admin.users.table.access" />
            </th>
            <th style={{ textAlign: "left" }}>
              <FormattedMessage id="admin.users.table.created" />
            </th>
            <th style={{ textAlign: "left" }}>
              <FormattedMessage id="admin.users.table.admin" />
            </th>
            <th style={{ width: 1 }}></th>
          </tr>
        </thead>
        <tbody>
          {isLoading
            ? skeletonRows
            : users.map((user) => (
                <tr key={user.id}>
                  <td>
                    {user.username}{" "}
                    {user.isLdap ? (
                      <Badge style={{ marginLeft: "1em" }}>LDAP</Badge>
                    ) : null}
                    {user.totpVerified && (
                      <Badge size="xs" ml={6} color="teal" variant="light">
                        2FA
                      </Badge>
                    )}
                    {["EMAIL_LINK", "ADMINISTRATOR"].includes(
                      user.emailVerificationSource || "",
                    ) && (
                      <Badge size="xs" ml={6} color="green" variant="light">
                        <FormattedMessage id="admin.users.table.email-verified" />
                      </Badge>
                    )}
                  </td>
                  <td>{user.email}</td>
                  <td>
                    <Badge color={accessColor()} variant="light">
                      Full access
                    </Badge>
                  </td>
                  <td>
                    <Text size="sm">{fmtDate(user.createdAt)}</Text>
                  </td>
                  <td>{user.isAdmin && <TbCheck />}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
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
                              showUpdateUserModal(modals, user, getUsers)
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
                  </td>
                </tr>
              ))}
        </tbody>
      </Table>
    </Box>
  );
};

const skeletonRows = [...Array(10)].map((v, i) => (
  <tr key={i}>
    <td>
      <Skeleton key={i} height={20} />
    </td>
    <td>
      <Skeleton key={i} height={20} />
    </td>
    <td>
      <Skeleton key={i} height={20} />
    </td>
    <td>
      <Skeleton key={i} height={20} />
    </td>
    <td>
      <Skeleton key={i} height={20} />
    </td>
    <td>
      <Skeleton key={i} height={20} />
    </td>
    <td>
      <Skeleton key={i} height={20} />
    </td>
  </tr>
));

export default ManageUserTable;
