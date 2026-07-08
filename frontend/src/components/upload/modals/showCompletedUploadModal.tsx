import { Button, Stack, Text, ThemeIcon } from "@mantine/core";
import { useModals } from "@mantine/modals";
import dayjs from "../../../utils/dayjs";
import { useRouter } from "next/router";
import { TbCircleCheck } from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import useTranslate, {
  translateOutsideContext,
} from "../../../hooks/useTranslate.hook";
import { CompletedShare } from "../../../types/share.type";
import CopyTextField from "../CopyTextField";
import useConfig from "../../../hooks/config.hook";
import { buildKeyFragment, getUserKey } from "../../../utils/crypto.util";

const showCompletedUploadModal = (
  modals: ReturnType<typeof useModals>,
  share: CompletedShare,
  e2eKeyEncoded?: string | null,
) => {
  const t = translateOutsideContext();
  return modals.openModal({
    closeOnClickOutside: false,
    withCloseButton: false,
    closeOnEscape: false,
    title: t("upload.modal.completed.share-ready"),
    children: <Body share={share} e2eKeyEncoded={e2eKeyEncoded} />,
  });
};

const Body = ({
  share,
  e2eKeyEncoded,
}: {
  share: CompletedShare;
  e2eKeyEncoded?: string | null;
}) => {
  const modals = useModals();
  const router = useRouter();
  const t = useTranslate();

  const isReverseShare = !!router.query["reverseShareToken"];

  const config = useConfig();
  const resolvedE2EKey =
    e2eKeyEncoded ||
    (share.isE2EEncrypted && !share.teamFolderId && !isReverseShare
      ? getUserKey()
      : null);
  const keyFragment = resolvedE2EKey ? buildKeyFragment(resolvedE2EKey) : "";
  const link = `${config.get("general.appUrl")}/s/${share.id}${keyFragment}`;

  return (
    <Stack align="stretch">
      <ThemeIcon
        color="green"
        variant="light"
        size="xl"
        radius="xl"
        style={{ alignSelf: "center" }}
      >
        <TbCircleCheck size={24} />
      </ThemeIcon>
      <CopyTextField link={link} />
      {share.notifyReverseShareCreator === true && (
        <Text size="sm" c="dimmed">
          {t("upload.modal.completed.notified-reverse-share-creator")}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {/* If our share.expiration is timestamp 0, show a different message */}
        {dayjs(share.expiration).unix() === 0
          ? t("upload.modal.completed.never-expires")
          : t("upload.modal.completed.expires-on", {
              expiration: dayjs(share.expiration).format("LLL"),
            })}
      </Text>

      <Button
        onClick={() => {
          modals.closeAll();
          if (isReverseShare) {
            router.push("/");
          } else {
            router.push("/upload");
          }
        }}
      >
        <FormattedMessage id="common.button.done" />
      </Button>
    </Stack>
  );
};

export default showCompletedUploadModal;
