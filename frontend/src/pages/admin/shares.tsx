import { Alert, Group, Space, Text, Title } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import { TbShieldLock } from "react-icons/tb";
import Meta from "../../components/Meta";
import ManageShareTable from "../../components/admin/shares/ManageShareTable";
import useTranslate from "../../hooks/useTranslate.hook";
import shareService from "../../services/share.service";
import { AdminShare } from "../../types/share.type";
import toast from "../../utils/toast.util";

const Shares = () => {
  const [shares, setShares] = useState<AdminShare[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const modals = useModals();
  const t = useTranslate();

  const getShares = () => {
    setIsLoading(true);
    shareService.list().then((shares) => {
      setShares(shares);
      setIsLoading(false);
    });
  };

  const deleteShare = (share: AdminShare) => {
    modals.openConfirmModal({
      title: t("admin.shares.edit.delete.title", {
        id: share.reference,
      }),
      children: (
        <Text size="sm">
          <FormattedMessage id="admin.shares.edit.delete.description" />
        </Text>
      ),
      labels: {
        confirm: t("common.button.delete"),
        cancel: t("common.button.cancel"),
      },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        shareService
          .removeFromAdminInventory(share.reference)
          .then(() =>
            setShares((current) =>
              current.filter(
                ({ reference }) => reference !== share.reference,
              ),
            ),
          )
          .catch(toast.axiosError);
      },
    });
  };

  useEffect(() => {
    getShares();
  }, []);

  return (
    <>
      <Meta title={t("admin.shares.title")} />
      <Group justify="space-between" align="baseline" mb={20}>
        <Title mb={30} order={3}>
          <FormattedMessage id="admin.shares.title" />
        </Title>
      </Group>

      <Alert
        color="teal"
        variant="light"
        icon={<TbShieldLock size={20} />}
        title={t("admin.shares.privacy.title")}
        mb="lg"
      >
        <FormattedMessage id="admin.shares.privacy.description" />
      </Alert>

      <ManageShareTable
        shares={shares}
        deleteShare={deleteShare}
        isLoading={isLoading}
      />
      <Space h="xl" />
    </>
  );
};

export default Shares;
