import {
  Button,
  Group,
  NativeSelect,
  PasswordInput,
  Stack,
  Switch,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { yupResolver } from "mantine-form-yup-resolver";
import { useModals } from "@mantine/modals";
import { FormattedMessage } from "react-intl";
import * as yup from "yup";
import useTranslate from "../../../hooks/useTranslate.hook";
import userService from "../../../services/user.service";
import toast from "../../../utils/toast.util";

const showCreateUserModal = (
  modals: ReturnType<typeof useModals>,
  smtpEnabled: boolean,
  getUsers: () => void,
) => {
  return modals.openModal({
    title: "Create user",
    children: (
      <Body modals={modals} smtpEnabled={smtpEnabled} getUsers={getUsers} />
    ),
  });
};

const Body = ({
  modals,
  smtpEnabled,
  getUsers,
}: {
  modals: ReturnType<typeof useModals>;
  smtpEnabled: boolean;
  getUsers: () => void;
}) => {
  const t = useTranslate();
  const form = useForm({
    initialValues: {
      username: "",
      email: "",
      password: undefined,
      isAdmin: false,
      setPasswordManually: false,
      plan: "TEAM",
    },
    validate: yupResolver(
      yup.object().shape({
        email: yup.string().email(t("common.error.invalid-email")),
        username: yup
          .string()
          .min(3, t("common.error.too-short", { length: 3 })),
        password: yup
          .string()
          .min(8, t("common.error.too-short", { length: 8 }))
          .optional(),
      }),
    ),
  });

  return (
    <Stack>
      <form
        onSubmit={form.onSubmit(async (values) => {
          const { setPasswordManually: _setPasswordManually, ...payload } = values;
          userService
            .create(payload)
            .then(() => {
              getUsers();
              modals.closeAll();
            })
            .catch(toast.axiosError);
        })}
      >
        <Stack>
          <TextInput
            label={t("admin.users.modal.create.username")}
            {...form.getInputProps("username")}
          />
          <TextInput
            label={t("admin.users.modal.create.email")}
            {...form.getInputProps("email")}
          />
          {smtpEnabled && (
            <Switch
              mt="xs"
              labelPosition="left"
              label={t("admin.users.modal.create.manual-password")}
              description={t(
                "admin.users.modal.create.manual-password.description",
              )}
              {...form.getInputProps("setPasswordManually", {
                type: "checkbox",
              })}
            />
          )}
          {(form.values.setPasswordManually || !smtpEnabled) && (
            <PasswordInput
              label={t("admin.users.modal.create.password")}
              {...form.getInputProps("password")}
            />
          )}
          <NativeSelect
            label={t("admin.users.modal.create.plan")}
            data={[
              { value: "TEAM", label: "Team" },
            ]}
            {...form.getInputProps("plan")}
          />
          <Switch
            styles={{
              body: {
                display: "flex",
                justifyContent: "space-between",
              },
            }}
            mt="xs"
            labelPosition="left"
            label={t("admin.users.modal.create.admin")}
            description={t("admin.users.modal.create.admin.description")}
            {...form.getInputProps("isAdmin", { type: "checkbox" })}
          />
          <Group justify="right">
            <Button type="submit">
              <FormattedMessage id="common.button.create" />
            </Button>
          </Group>
        </Stack>
      </form>
    </Stack>
  );
};

export default showCreateUserModal;
