import { Badge, Button, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TbFingerprint, TbTrash } from "react-icons/tb";
import useTranslate from "../../hooks/useTranslate.hook";
import signingService from "../../services/signing.service";
import toast from "../../utils/toast.util";

const PASSKEYS_QUERY_KEY = ["signing-passkeys"];

/**
 * Passkeys enrolled for reinforced signatures. Shown only once the account has
 * one, so that a passkey deleted from a phone or a password manager can also
 * be removed here.
 */
const SigningPasskeysSection = () => {
  const t = useTranslate();
  const modals = useModals();
  const queryClient = useQueryClient();

  const { data: passkeys } = useQuery({
    queryKey: PASSKEYS_QUERY_KEY,
    queryFn: signingService.listSigningPasskeys,
  });

  const deleteMutation = useMutation({
    mutationFn: signingService.deleteSigningPasskey,
    onSuccess: async () => {
      toast.success(t("account.card.signing-passkeys.deleted"));
      await queryClient.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY });
    },
    onError: toast.axiosError,
  });

  if (!passkeys?.length) return null;

  const confirmDelete = (id: string) =>
    modals.openConfirmModal({
      title: t("account.card.signing-passkeys.confirm.title"),
      children: (
        <Text size="sm">{t("account.card.signing-passkeys.confirm.text")}</Text>
      ),
      labels: {
        confirm: t("account.card.signing-passkeys.delete"),
        cancel: t("common.button.cancel"),
      },
      confirmProps: { color: "red" },
      onConfirm: () => deleteMutation.mutate(id),
    });

  return (
    <Paper withBorder p="xl" mt="lg">
      <Title order={5} mb="xs">
        {t("account.card.signing-passkeys.title")}
      </Title>
      <Text size="sm" c="dimmed" mb="md">
        {t("account.card.signing-passkeys.description")}
      </Text>
      <Stack gap="sm">
        {passkeys.map((passkey) => (
          <Group key={passkey.id} justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              <TbFingerprint size={20} />
              <Stack gap={2}>
                <Group gap="xs">
                  <Text size="sm">
                    {t("account.card.signing-passkeys.created", {
                      date: new Date(passkey.createdAt).toLocaleDateString(),
                    })}
                  </Text>
                  <Badge size="xs" variant="light">
                    {passkey.deviceType === "multiDevice"
                      ? t("account.card.signing-passkeys.synced")
                      : t("account.card.signing-passkeys.device-bound")}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed">
                  {passkey.lastUsedAt
                    ? t("account.card.signing-passkeys.last-used", {
                        date: new Date(passkey.lastUsedAt).toLocaleDateString(),
                      })
                    : t("account.card.signing-passkeys.never-used")}
                </Text>
              </Stack>
            </Group>
            <Button
              variant="light"
              color="red"
              size="xs"
              leftSection={<TbTrash size={14} />}
              loading={
                deleteMutation.isPending &&
                deleteMutation.variables === passkey.id
              }
              onClick={() => confirmDelete(passkey.id)}
            >
              {t("account.card.signing-passkeys.delete")}
            </Button>
          </Group>
        ))}
      </Stack>
    </Paper>
  );
};

export default SigningPasskeysSection;
