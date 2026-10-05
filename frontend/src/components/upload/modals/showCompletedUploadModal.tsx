import { Alert, Button, Stack, Text, ThemeIcon } from "@mantine/core";
import { useModals } from "@mantine/modals";
import dayjs from "../../../utils/dayjs";
import { useRouter } from "next/router";
import { TbAlertTriangle, TbCircleCheck } from "react-icons/tb";
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
  requiresE2EBackup = false,
  failedFileCount = 0,
) => {
  const t = translateOutsideContext();
  return modals.openModal({
    closeOnClickOutside: false,
    withCloseButton: false,
    closeOnEscape: false,
    title: t(
      failedFileCount > 0
        ? "upload.modal.completed.share-incomplete"
        : "upload.modal.completed.share-ready",
    ),
    children: (
      <Body
        share={share}
        e2eKeyEncoded={e2eKeyEncoded}
        requiresE2EBackup={requiresE2EBackup}
        failedFileCount={failedFileCount}
      />
    ),
  });
};

const Body = ({
  share,
  e2eKeyEncoded,
  requiresE2EBackup,
  failedFileCount,
}: {
  share: CompletedShare;
  e2eKeyEncoded?: string | null;
  requiresE2EBackup: boolean;
  failedFileCount: number;
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
        color={failedFileCount > 0 ? "yellow" : "green"}
        variant="light"
        size="xl"
        radius="xl"
        style={{ alignSelf: "center" }}
      >
        {failedFileCount > 0 ? (
          <TbAlertTriangle size={24} />
        ) : (
          <TbCircleCheck size={24} />
        )}
      </ThemeIcon>
      <CopyTextField link={link} />
      {failedFileCount > 0 && (
        <Alert color="yellow" title={t("upload.modal.completed.partial-title")}>
          {t("upload.modal.completed.partial-body", { count: failedFileCount })}
        </Alert>
      )}
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
          } else if (requiresE2EBackup) {
            router.push("/account#e2e-encryption-settings");
          } else {
            router.push("/upload");
          }
        }}
      >
        <FormattedMessage
          id={
            requiresE2EBackup
              ? "upload.modal.completed.e2e-backup-action"
              : "common.button.done"
          }
        />
      </Button>
    </Stack>
  );
};

export default showCompletedUploadModal;
