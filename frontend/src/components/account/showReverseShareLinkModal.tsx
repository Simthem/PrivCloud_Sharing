import { Stack, TextInput } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { translateOutsideContext } from "../../hooks/useTranslate.hook";

const showReverseShareLinkModal = (
  modals: ReturnType<typeof useModals>,
  link: string,
) => {
  const t = translateOutsideContext();
  return modals.openModal({
    title: t("account.reverseShares.modal.reverse-share-link"),
    children: <ReverseShareLinkContent link={link} />,
  });
};

const ReverseShareLinkContent = ({ link }: { link: string }) => {
  return (
    <Stack align="stretch">
      <TextInput variant="filled" value={link} readOnly />
    </Stack>
  );
};

export default showReverseShareLinkModal;
