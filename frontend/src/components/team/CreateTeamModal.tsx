import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/router";
import {
  Button,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { TbUsersGroup } from "react-icons/tb";
import teamService from "../../services/team.service";
import {
  generateEncryptionKey,
  importKeyFromBase64,
  getUserKey,
  wrapReverseShareKey,
} from "../../utils/crypto.util";
import toast from "../../utils/toast.util";
import { useIntl } from "react-intl";

interface CreateTeamModalProps {
  opened: boolean;
  onClose: () => void;
  /** If true, the modal cannot be dismissed (user MUST create a team) */
  mandatory?: boolean;
}

const CreateTeamModal = ({ opened, onClose, mandatory }: CreateTeamModalProps) => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const intl = useIntl();

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
    onSuccess: async (team) => {
      // Generate team E2E key and store wrapped by user's master key
      try {
        const userKeyB64 = getUserKey();
        if (userKeyB64) {
          const teamKey = await generateEncryptionKey();
          const masterKey = await importKeyFromBase64(userKeyB64);
          const wrappedTeamKey = await wrapReverseShareKey(teamKey, masterKey);
          await teamService.setTeamKey(team.id, wrappedTeamKey);
        }
      } catch (e) {
        console.warn("[E2E] Failed to generate team key:", e);
      }

      toast.success(
        intl.formatMessage(
          { id: "team.create.success" },
          { name: team.name },
        ),
      );
      queryClient.invalidateQueries({ queryKey: ["teams.list"] });
      queryClient.invalidateQueries({ queryKey: ["teams.status"] });
      onClose();
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
    <Modal
      opened={opened}
      onClose={mandatory ? () => {} : onClose}
      title={
        <Group gap="xs">
          <TbUsersGroup size={20} />
          <Text fw={600}>
            {intl.formatMessage({ id: "team.create.modal.title" })}
          </Text>
        </Group>
      }
      withCloseButton={!mandatory}
      closeOnClickOutside={!mandatory}
      closeOnEscape={!mandatory}
      size="md"
    >
      <form
        onSubmit={form.onSubmit((values) =>
          createMutation.mutate({
            name: values.name.trim(),
            description: values.description?.trim() || undefined,
          }),
        )}
      >
        <Stack gap="md">
          {mandatory && (
            <Text size="sm" c="dimmed">
              {intl.formatMessage({ id: "team.create.modal.mandatory-info" })}
            </Text>
          )}

          <TextInput
            label={intl.formatMessage({ id: "team.create.modal.name-label" })}
            description={intl.formatMessage({ id: "team.create.modal.name-hint" })}
            placeholder="Mon Équipe @Work"
            required
            {...form.getInputProps("name")}
          />

          <Textarea
            label={intl.formatMessage({ id: "team.create.modal.description-label" })}
            placeholder={intl.formatMessage({
              id: "team.create.modal.description-placeholder",
            })}
            {...form.getInputProps("description")}
          />

          <Text size="xs" c="dimmed">
            {intl.formatMessage({ id: "team.create.modal.slug-auto" })}
          </Text>

          <Group justify="flex-end">
            {!mandatory && (
              <Button variant="subtle" onClick={onClose}>
                {intl.formatMessage({ id: "common.button.cancel" })}
              </Button>
            )}
            <Button type="submit" loading={createMutation.isPending}>
              {intl.formatMessage({ id: "team.create.modal.submit" })}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
};

export default CreateTeamModal;
