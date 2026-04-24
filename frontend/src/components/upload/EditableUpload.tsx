import { Button, Group, Text } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { cleanNotifications } from "@mantine/notifications";
import { useRouter } from "next/router";
import pLimit from "p-limit";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import Dropzone from "../../components/upload/Dropzone";
import FileList from "../../components/upload/FileList";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import useWakeLock from "../../hooks/useWakeLock.hook";
import shareService from "../../services/share.service";
import { FileListItem, FileMetaData, FileUpload } from "../../types/File.type";
import toast from "../../utils/toast.util";
import {
  getUserKey,
  importKeyFromBase64,
} from "../../utils/crypto.util";
import { useQueryClient } from "@tanstack/react-query";
import {
  getAdaptiveChunkSize,
  uploadFileViaWorker,
} from "../../utils/upload.util";

let errorToastShown = false;

const EditableUpload = ({
  maxShareSize,
  shareId,
  files: savedFiles = [],
  isE2EEncrypted,
}: {
  maxShareSize?: number;
  isReverseShare?: boolean;
  shareId: string;
  files?: FileMetaData[];
  isE2EEncrypted?: boolean;
}) => {
  const t = useTranslate();
  const router = useRouter();
  const config = useConfig();
  const modals = useModals();
  const queryClient = useQueryClient();
  const wakeLock = useWakeLock();
  const uploadAbortRef = useRef<AbortController | null>(null);

  const chunkSize = useRef(parseInt(config.get("share.chunkSize")));

  const [existingFiles, setExistingFiles] =
    useState<Array<FileMetaData & { deleted?: boolean }>>(savedFiles);
  const [uploadingFiles, setUploadingFiles] = useState<FileUpload[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const existingAndUploadedFiles: FileListItem[] = useMemo(
    () => [...uploadingFiles, ...existingFiles],
    [existingFiles, uploadingFiles],
  );
  const dirty = useMemo(() => {
    return (
      existingFiles.some((file) => !!file.deleted) || !!uploadingFiles.length
    );
  }, [existingFiles, uploadingFiles]);

  const setFiles = (files: FileListItem[]) => {
    const _uploadFiles = files.filter(
      (file) => "uploadingProgress" in file,
    ) as FileUpload[];
    const _existingFiles = files.filter(
      (file) => !("uploadingProgress" in file),
    ) as FileMetaData[];

    setUploadingFiles(_uploadFiles);
    setExistingFiles(_existingFiles);
  };

  const effectiveMaxShareSize = maxShareSize ?? parseInt(config.get("share.maxSize"));

  const uploadFiles = async (files: FileUpload[]) => {
    // E2E: enforce encryption consistency -- if the share is encrypted,
    // uploading without a key would store plaintext files alongside
    // encrypted ones, corrupting the share integrity.
    let e2eCryptoKey: CryptoKey | null = null;
    if (isE2EEncrypted) {
      const userKey = getUserKey();
      if (!userKey) {
        toast.error(t("share.edit.notify.e2e-key-missing"));
        throw new Error("E2E_KEY_MISSING");
      }
      e2eCryptoKey = await importKeyFromBase64(userKey);
    }

    const effectiveChunkSize = await getAdaptiveChunkSize(chunkSize.current);
    const uploadLimit = pLimit(3);

    const abortCtrl = new AbortController();
    uploadAbortRef.current = abortCtrl;

    const fileUploadPromises = files.map((file, fileIndex) =>
      uploadLimit(async () => {
        const setFileProgress = (progress: number) => {
          setUploadingFiles((files) =>
            files.map((f, i) => {
              if (i === fileIndex) f.uploadingProgress = progress;
              return f;
            }),
          );
        };

        setFileProgress(1);

        const totalChunks = Math.max(
          1,
          Math.ceil(file.size / effectiveChunkSize),
        );

        try {
          await uploadFileViaWorker(
            file,
            shareId,
            effectiveChunkSize,
            totalChunks,
            !!isE2EEncrypted,
            e2eCryptoKey,
            (chunkIndex, totalChunks) => {
              setFileProgress(((chunkIndex + 1) / totalChunks) * 100);
            },
            abortCtrl.signal,
          );
        } catch (e: any) {
          if (e?.cancelled) return; // user cancelled
          if (
            e?.status === 413 ||
            (e?.status === 403 && e?.quota)
          ) {
            if (!errorToastShown) {
              toast.error(e?.message || "Quota exceeded");
              errorToastShown = true;
            }
          }
          setFileProgress(-1);
        }
      }),
    );

    await Promise.all(fileUploadPromises);
  };

  const removeFiles = async () => {
    const removedFiles = existingFiles.filter((file) => !!file.deleted);

    if (removedFiles.length > 0) {
      await Promise.all(
        removedFiles.map(async (file) => {
          await shareService.removeFile(shareId, file.id);
        }),
      );

      setExistingFiles(existingFiles.filter((file) => !file.deleted));
    }
  };

  const revertComplete = async () => {
    await shareService.revertComplete(shareId).then();
  };

  const completeShare = async () => {
    return await shareService.completeShare(shareId);
  };

  const save = async () => {
    // E2E validation: block save if share is encrypted but key is missing
    if (isE2EEncrypted && uploadingFiles.length > 0) {
      const userKey = getUserKey();
      if (!userKey) {
        toast.error(t("share.edit.notify.e2e-key-missing"));
        return;
      }
    }

    // Pre-check: estimate if new files would exceed max share size
    const existingSize = existingFiles
      .filter((f) => !f.deleted)
      .reduce((sum, f) => sum + parseInt(f.size || "0"), 0);
    const newFilesSize = uploadingFiles.reduce((sum, f) => sum + f.size, 0);
    if (
      effectiveMaxShareSize &&
      existingSize + newFilesSize > effectiveMaxShareSize
    ) {
      toast.error(
        t("upload.dropzone.notify.file-too-big", {
          maxSize:
            effectiveMaxShareSize >= 1000000000
              ? `${(effectiveMaxShareSize / 1000000000).toFixed(1)} GB`
              : `${Math.round(effectiveMaxShareSize / 1000000)} MB`,
        }),
      );
      return;
    }

    errorToastShown = false;
    setIsUploading(true);
    await wakeLock.acquire();
    let reverted = false;

    try {
      await revertComplete();
      reverted = true;

      await uploadFiles(uploadingFiles);

      const hasFailed = uploadingFiles.some(
        (file) => file.uploadingProgress == -1,
      );

      if (!hasFailed) {
        await removeFiles();
      }

      await completeShare();
      reverted = false;

      if (!hasFailed) {
        queryClient.invalidateQueries({ queryKey: ["share", shareId] });
        toast.success(t("share.edit.notify.save-success"));
        router.back();
      }
    } catch (e: any) {
      if (e?.message !== "E2E_KEY_MISSING") {
        toast.error(t("share.edit.notify.generic-error"));
      }
    } finally {
      // CRITICAL: Always re-lock the share to prevent cron deletion.
      // If revertComplete was called but completeShare did not succeed,
      // the share is in uploadLocked=false state and the cron job
      // deleteUnfinishedShares would permanently delete it after 24h.
      if (reverted) {
        try {
          await completeShare();
        } catch {
          // completeShare may fail (e.g. share has 0 files after all
          // uploads failed). The cron grace period was reset by
          // revertComplete (createdAt = now), giving 24h to retry.
        }
      }
      setIsUploading(false);
      wakeLock.release();
    }
  };

  const appendFiles = (appendingFiles: FileUpload[]) => {
    setUploadingFiles([...appendingFiles, ...uploadingFiles]);
  };

  const cancelUpload = () => {
    modals.openConfirmModal({
      title: t("upload.cancel.title", { defaultMessage: "Cancel upload" }),
      children: (
        <Text size="sm">
          <FormattedMessage
            id="upload.cancel.confirm"
            defaultMessage="The upload in progress will be interrupted. Continue?"
          />
        </Text>
      ),
      labels: {
        confirm: t("common.button.confirm", { defaultMessage: "Confirm" }),
        cancel: t("common.button.cancel", { defaultMessage: "No" }),
      },
      confirmProps: { color: "red" },
      onConfirm: () => {
        uploadAbortRef.current?.abort();
        uploadAbortRef.current = null;

        setUploadingFiles((prev) =>
          prev.map((f) => {
            if (f.uploadingProgress !== undefined && f.uploadingProgress < 100) {
              f.uploadingProgress = -1;
            }
            return f;
          }),
        );
        toast.error(t("upload.cancel.done", { defaultMessage: "Upload cancelled" }));
      },
    });
  };

  useEffect(() => {
    // Check if there are any files that failed to upload
    const fileErrorCount = uploadingFiles.filter(
      (file) => file.uploadingProgress == -1,
    ).length;

    if (fileErrorCount > 0) {
      if (!errorToastShown) {
        toast.error(
          t("upload.notify.count-failed", { count: fileErrorCount }),
          {
            withCloseButton: false,
            autoClose: false,
          },
        );
      }
      errorToastShown = true;
    } else {
      cleanNotifications();
      errorToastShown = false;
    }
  }, [uploadingFiles]);

  return (
    <>
      <Group position="right" mb={20} spacing="xs">
        {isUploading && (
          <Button size="sm" color="red" variant="subtle" onClick={cancelUpload}>
            <FormattedMessage
              id="upload.cancel.button"
              defaultMessage="Cancel"
            />
          </Button>
        )}
        <Button loading={isUploading} disabled={!dirty} onClick={() => save()}>
          <FormattedMessage id="common.button.save" />
        </Button>
      </Group>
      <Dropzone
        title={t("share.edit.append-upload")}
        maxShareSize={effectiveMaxShareSize}
        onFilesChanged={appendFiles}
        isUploading={isUploading}
      />
      {existingAndUploadedFiles.length > 0 && (
        <FileList files={existingAndUploadedFiles} setFiles={setFiles} />
      )}
    </>
  );
};
export default EditableUpload;
