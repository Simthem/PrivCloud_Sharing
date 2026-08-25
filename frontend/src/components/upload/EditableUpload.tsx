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
import useUser from "../../hooks/user.hook";
import useWakeLock from "../../hooks/useWakeLock.hook";
import configService from "../../services/config.service";
import shareService from "../../services/share.service";
import { FileListItem, FileMetaData, FileUpload } from "../../types/File.type";
import toast from "../../utils/toast.util";
import { getUserKey, importKeyFromBase64 } from "../../utils/crypto.util";
import { useQueryClient } from "@tanstack/react-query";
import {
  getAdaptiveChunkSize,
  measureBandwidthForUpload,
  prewarmUploadBandwidth,
  uploadFileViaWorker,
} from "../../utils/upload.util";
import {
  clampUploadChunkSizeLimit,
  getRuntimeUploadChunkConfigKey,
  getUploadChunkProfile,
  getUploadChunkSizeLimit,
  getUploadSchedulingProfile,
} from "../../utils/uploadPerformance.util";

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
  const { user } = useUser();
  const uploadAbortRef = useRef<AbortController | null>(null);

  const chunkSize = useRef(parseInt(config.get("share.chunkSize")));

  const [existingFiles, setExistingFiles] =
    useState<Array<FileMetaData & { deleted?: boolean }>>(savedFiles);
  const [uploadingFiles, setUploadingFiles] = useState<FileUpload[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    prewarmUploadBandwidth();
  }, []);

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

  const effectiveMaxShareSize =
    maxShareSize ?? parseInt(config.get("share.maxSize"));

  const uploadFiles = async (files: FileUpload[]) => {
    const uploadChunkProfile = {
      isAuthenticated: !!user,
    };
    const runtimeUploadProfile = getUploadChunkProfile(uploadChunkProfile);
    const runtimeUploadProfileKey =
      getRuntimeUploadChunkConfigKey(runtimeUploadProfile);
    const runtimeMaxChunkSizePromise = configService
      .getRuntimeUploadMaxChunkSize(runtimeUploadProfile)
      .catch(
        () =>
          config.get(runtimeUploadProfileKey) ??
          config.get("runtime.uploadMaxChunkBytes"),
      );

    // E2E: enforce encryption consistency -- if the share is encrypted,
    // uploading without a key would store plaintext files alongside
    // encrypted ones, corrupting the share integrity.
    let keyPromise: Promise<CryptoKey | null> = Promise.resolve(null);
    if (isE2EEncrypted) {
      const userKey = getUserKey();
      if (!userKey) {
        toast.error(t("share.edit.notify.e2e-key-missing"));
        throw new Error("E2E_KEY_MISSING");
      }
      keyPromise = importKeyFromBase64(userKey);
    }

    // Crypto preparation and the bounded, cached probe run concurrently.
    const [e2eCryptoKey, measuredBandwidth, runtimeMaxChunkSize] =
      await Promise.all([
        keyPromise,
        measureBandwidthForUpload(),
        runtimeMaxChunkSizePromise,
      ]);
    const maxUploadChunkSize = clampUploadChunkSizeLimit(
      getUploadChunkSizeLimit(uploadChunkProfile),
      runtimeMaxChunkSize,
    );
    const effectiveChunkSizes = await Promise.all(
      files.map((file) =>
        getAdaptiveChunkSize(
          chunkSize.current,
          file.size,
          measuredBandwidth,
          maxUploadChunkSize,
        ),
      ),
    );
    const localFileIndexes = files
      .map((_file, fileIndex) => fileIndex)
      .filter((fileIndex) => !files[fileIndex].privcloudBridgeSource);
    const hasBridgeUpload = localFileIndexes.length !== files.length;
    const uploadSchedulingProfile = getUploadSchedulingProfile(
      localFileIndexes.map((fileIndex) => files[fileIndex].size),
      localFileIndexes.map((fileIndex) => effectiveChunkSizes[fileIndex]),
      2,
      hasBridgeUpload,
    );
    console.info(
      `[upload] scheduler -> mode=${uploadSchedulingProfile.mode} ` +
        `localFiles=${localFileIndexes.length} ` +
        `fileConcurrency=${uploadSchedulingProfile.fileConcurrency} ` +
        `lanePolicy=server-adaptive ` +
        `protocolSafetyCap=${uploadSchedulingProfile.maxParallelLanes}`,
    );
    const uploadLimit = pLimit(uploadSchedulingProfile.fileConcurrency);

    const abortCtrl = new AbortController();
    uploadAbortRef.current = abortCtrl;

    const scheduledFiles = files.map((file, fileIndex) => ({
      file,
      fileIndex,
    }));
    if (uploadSchedulingProfile.mode === "server-managed") {
      scheduledFiles.sort((left, right) => {
        const leftIsMultipart =
          !left.file.privcloudBridgeSource &&
          left.file.size > effectiveChunkSizes[left.fileIndex];
        const rightIsMultipart =
          !right.file.privcloudBridgeSource &&
          right.file.size > effectiveChunkSizes[right.fileIndex];
        if (leftIsMultipart !== rightIsMultipart) {
          return leftIsMultipart ? -1 : 1;
        }
        return left.fileIndex - right.fileIndex;
      });
    }

    const fileUploadPromises = scheduledFiles.map(({ file, fileIndex }) =>
      uploadLimit(async () => {
        const effectiveChunkSize = effectiveChunkSizes[fileIndex];
        const setFileProgress = (progress: number) => {
          setUploadingFiles((files) =>
            files.map((f, i) => {
              if (i === fileIndex) f.uploadingProgress = progress;
              return f;
            }),
          );
        };

        setFileProgress(0);

        try {
          await uploadFileViaWorker(
            file,
            shareId,
            effectiveChunkSize,
            !!isE2EEncrypted,
            e2eCryptoKey,
            (_chunkIndex, _totalChunks, _fileId, uploadedBytes) => {
              setFileProgress(
                Math.min(100, (uploadedBytes / Math.max(file.size, 1)) * 100),
              );
            },
            abortCtrl.signal,
            file.uploadRelativePath,
            uploadSchedulingProfile.maxParallelLanes,
            uploadSchedulingProfile.fileConcurrency,
          );
        } catch (e: any) {
          if (e?.cancelled) return; // user cancelled
          if (e?.status === 413 || e?.sizeLimit) {
            if (!errorToastShown) {
              toast.error(e?.message || "Configured size limit exceeded");
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
    let uploadHeartbeat: ReturnType<typeof setInterval> | null = null;
    let uploadHeartbeatInFlight = false;

    try {
      await revertComplete();
      reverted = true;
      uploadHeartbeat = setInterval(() => {
        if (uploadHeartbeatInFlight) return;
        uploadHeartbeatInFlight = true;
        void shareService
          .keepUploadAlive(shareId)
          .catch(() => {})
          .finally(() => {
            uploadHeartbeatInFlight = false;
          });
      }, 2 * 60_000);

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
      if (uploadHeartbeat) clearInterval(uploadHeartbeat);

      // Restore the published state immediately when possible. The persistent
      // completion marker remains the final safety net if this request cannot
      // reach the backend: cleanup will re-lock the edit without deleting it.
      if (reverted) {
        try {
          await completeShare();
        } catch {
          // completeShare may fail (e.g. share has 0 files after all
          // uploads failed). The completion marker ensures the inactivity
          // cleanup preserves and re-locks the existing share even if this
          // best-effort call fails.
        }
      }
      setIsUploading(false);
      wakeLock.release();
    }
  };

  const appendFiles = (appendingFiles: FileUpload[]) => {
    if (appendingFiles.length > 0) prewarmUploadBandwidth(true);
    setUploadingFiles([...appendingFiles, ...uploadingFiles]);
  };

  const cancelUpload = () => {
    modals.openConfirmModal({
      title: t("upload.cancel.title", { defaultMessage: "Annuler l'envoi" }),
      children: (
        <Text size="sm">
          <FormattedMessage
            id="upload.cancel.confirm"
            defaultMessage="L'envoi en cours sera interrompu. Continuer ?"
          />
        </Text>
      ),
      labels: {
        confirm: t("common.button.confirm", { defaultMessage: "Confirmer" }),
        cancel: t("common.button.cancel", { defaultMessage: "Non" }),
      },
      confirmProps: { color: "red" },
      onConfirm: () => {
        uploadAbortRef.current?.abort();
        uploadAbortRef.current = null;

        setUploadingFiles((prev) =>
          prev.map((f) => {
            if (
              f.uploadingProgress !== undefined &&
              f.uploadingProgress < 100
            ) {
              f.uploadingProgress = -1;
            }
            return f;
          }),
        );
        toast.success(
          t("upload.cancel.done", { defaultMessage: "Envoi annulé" }),
        );
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
            autoClose: false,
          },
        );
      }
      errorToastShown = true;
    } else {
      cleanNotifications();
      errorToastShown = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadingFiles]);

  return (
    <>
      <Group justify="right" mb={20} gap="xs">
        {isUploading && (
          <Button size="sm" color="red" variant="subtle" onClick={cancelUpload}>
            <FormattedMessage
              id="upload.cancel.button"
              defaultMessage="Annuler"
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
