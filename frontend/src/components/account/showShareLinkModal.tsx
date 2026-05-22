import { Stack, TextInput } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { translateOutsideContext } from "../../hooks/useTranslate.hook";
import useConfig from "../../hooks/config.hook";

const showShareLinkModal = (
  modals: ReturnType<typeof useModals>,
  shareId: string,
  keyFragment?: string,
) => {
  const t = translateOutsideContext();
  return modals.openModal({
    title: t("account.shares.modal.share-link"),
    children: <ShareLinkContent shareId={shareId} keyFragment={keyFragment} />,
  });
};

const ShareLinkContent = ({
  shareId,
  keyFragment,
}: {
  shareId: string;
  keyFragment?: string;
}) => {
  const config = useConfig();
  const link = `${config.get("general.appUrl")}/s/${shareId}${keyFragment || ""}`;
  return (
    <Stack align="stretch">
      <TextInput variant="filled" value={link} readOnly />
    </Stack>
  );
};

export default showShareLinkModal;
