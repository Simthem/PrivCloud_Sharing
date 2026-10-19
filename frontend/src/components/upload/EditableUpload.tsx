import {
  synchronizeCompletedUpload,
  synchronizeRemovedShare,
} from "../../utils/uploadStateCache.util";
import { prepareSafeLineRetry } from "../../utils/safelineChallenge.util";
import {
  readUploadResumeEntries,
  matchUploadResumeEntry,
  type UploadResumeEntry,
} from "../../utils/uploadResume.util";
import { startUploadSessionMaintenance } from "../../utils/uploadSessionMaintenance.util";
import {
  isUploadActive,
  setUploadActive,
  completeSafeLineChallenge,
} from "../../services/api.service";
import { finalizeUpload } from "../../utils/uploadCompletion.util";
import useConfirmLeave from "../../hooks/confirm-leave.hook";
import { Alert, Button, Group, Text } from "@mantine/core";
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
import { isFileMetaShare } from "../../utils/fileMetadata.util";
import toast from "../../utils/toast.util";
import { getUserKey, importKeyFromBase64 } from "../../utils/crypto.util";
import {
  SHARE_DEK_V1,
  resolveOwnerShareKey,
  resolveShareCryptoScheme,
} from "../../utils/shareKey.util";
import { reportShareCryptoEvent } from "../../utils/shareCryptoEvents.util";
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
  ownerKey,
  uploadPending,
  shareId,
  files: savedFiles = [],
  isE2EEncrypted,
  cryptoScheme,
  fileMetadataScheme,
}: {
  maxShareSize?: number;
  ownerKey?: string | null;
  uploadPending?: boolean;
  isReverseShare?: boolean;
  shareId: string;
  files?: FileMetaData[];
  isE2EEncrypted?: boolean;
  cryptoScheme?: number | null;
  fileMetadataScheme?: number | null;
}) => {
  const t = useTranslate();
  const router = useRouter();
  const config = useConfig();
  const modals = useModals();
  const queryClient = useQueryClient();
  const wakeLock = useWakeLock();
  const { user } = useUser();
  const uploadAbortRef = useRef<AbortController | null>(null);
  const maintenanceRef = useRef<(() => void) | null>(null);
  const [pendingFinalization, setPendingFinalization] = useState(false);
  const [resumeEntries, setResumeEntries] = useState<UploadResumeEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (ownerKey)
      void importKeyFromBase64(ownerKey)
        .then((key) => readUploadResumeEntries(shareId, key))
        .then((entries) => {
          if (!cancelled)
            setResumeEntries(
              entries.filter(
                (entry) => !savedFiles.some((file) => file.id === entry.fileId),
              ),
            );
        })
        .catch(() => {
          if (!cancelled) setResumeEntries([]);
        });
    return () => {
      cancelled = true;
    };
  }, [ownerKey, shareId, savedFiles]);
  useEffect(
    () => () => {
      uploadAbortRef.current?.abort();
      maintenanceRef.current?.();
      setUploadActive(false);
    },
    [],
  );

  const chunkSize = useRef(parseInt(config.get("share.chunkSize")));

  const [existingFiles, setExistingFiles] =
    useState<Array<FileMetaData & { deleted?: boolean }>>(savedFiles);
  const [uploadingFiles, setUploadingFiles] = useState<FileUpload[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  useConfirmLeave({
    message: t("upload.notify.confirm-leave"),
    enabled: isUploading || pendingFinalization,
  });

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
      // Files added to a SHARE_DEK_V1 share must use its K_share, or the
      // recipient link would no longer open them. Legacy shares keep K_master.
      let scheme: number;
      try {
        scheme = resolveShareCryptoScheme(cryptoScheme);
      } catch {
        toast.error(t("share.edit.notify.e2e-key-missing"));
        throw new Error("E2E_SCHEME_UNSUPPORTED");
      }
      keyPromise = ownerKey
        ? importKeyFromBase64(ownerKey)
        : scheme === SHARE_DEK_V1
          ? shareService
              .getShareKeyMaterial(shareId)
              .then((material) =>
                resolveOwnerShareKey(shareId, userKey, {
                  cryptoScheme: material.cryptoScheme,
                  wrappedShareKey: material.wrappedShareKey,
                }),
              )
              .then(importKeyFromBase64)
              .catch((error) => {
                reportShareCryptoEvent("unwrap_error", SHARE_DEK_V1);
                toast.error(t("share.edit.notify.e2e-key-missing"));
                throw error;
              })
          : importKeyFromBase64(userKey);
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
            files.map((f) => {
              if (f === file) f.uploadingProgress = progress;
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
                Math.min(99, (uploadedBytes / Math.max(file.size, 1)) * 100),
              );
            },
            abortCtrl.signal,
            file.uploadRelativePath,
            uploadSchedulingProfile.maxParallelLanes,
            uploadSchedulingProfile.fileConcurrency,
            // Every file of a FILE_META_V1 share, old or new, hides its name.
            isFileMetaShare({ fileMetadataScheme }),
          );
          setFileProgress(100);
          return true;
        } catch (e: any) {
          if (e?.cancelled) {
            setFileProgress(-1);
            return false;
          }
          if (e?.status === 413 || e?.sizeLimit) {
            if (!errorToastShown) {
              toast.error(e?.message || "Configured size limit exceeded");
              errorToastShown = true;
            }
          }
          setFileProgress(-1);
          return false;
        }
      }),
    );

    // React may defer progress updates. Only worker results decide completion.
    const results = await Promise.all(fileUploadPromises);
    return results.every(Boolean);
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
    return await finalizeUpload(
      () => shareService.completeShare(shareId),
      () => shareService.getFromOwner(shareId),
      shareId,
    );
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

    try {
      await prepareSafeLineRetry();
    } catch {
      toast.error(t("share.edit.notify.generic-error"));
      return;
    }
    // An explicit empty edit deletes the share directly. On a failed DELETE,
    // preserve its prior published/pending state and allow the owner to retry.
    if (
      existingFiles.some((file) => file.deleted) &&
      existingFiles.every((file) => file.deleted) &&
      uploadingFiles.length === 0
    ) {
      setIsUploading(true);
      try {
        await shareService.remove(shareId, true);
        await synchronizeRemovedShare(queryClient, shareId);
        setPendingFinalization(false);
        maintenanceRef.current?.();
        maintenanceRef.current = null;
        setUploadActive(false);
        toast.success(t("account.shares.notify.deleted-success"));
        router.back();
      } catch {
        toast.error(t("share.edit.notify.generic-error"));
      } finally {
        setIsUploading(false);
      }
      return;
    }
    errorToastShown = false;
    setIsUploading(true);
    await wakeLock.acquire();
    let reverted = false;

    try {
      await revertComplete();
      reverted = true;
      setUploadActive(true);
      maintenanceRef.current?.();
      maintenanceRef.current = startUploadSessionMaintenance({
        isActive: isUploadActive,
        heartbeat: () => shareService.keepUploadAlive(shareId),
        resolveChallenge: completeSafeLineChallenge,
      });

      const hasFailed = !(await uploadFiles(
        uploadingFiles.filter((file) => file.uploadingProgress !== 100),
      ));

      if (!hasFailed) {
        await removeFiles();
      }

      if (hasFailed) throw new Error("UPLOAD_INCOMPLETE");
      await completeShare();
      await synchronizeCompletedUpload(queryClient, shareId);
      reverted = false;
      setPendingFinalization(false);

      if (!hasFailed) {
        toast.success(t("share.edit.notify.save-success"));
        router.back();
      }
    } catch (e: any) {
      if (e?.message !== "E2E_KEY_MISSING") {
        toast.error(t("share.edit.notify.generic-error"));
      }
    } finally {
      // Restore the published state immediately when possible. The persistent
      // completion marker remains the final safety net if this request cannot
      // reach the backend: cleanup will re-lock the edit without deleting it.
      if (reverted && !uploadPending) {
        try {
          await completeShare();
          await synchronizeCompletedUpload(queryClient, shareId);
          reverted = false;
        } catch {
          // completeShare may fail (e.g. share has 0 files after all
          // uploads failed). The completion marker ensures the inactivity
          // cleanup preserves and re-locks the existing share even if this
          // best-effort call fails.
        }
      }
      setPendingFinalization(reverted);
      if (!reverted) {
        maintenanceRef.current?.();
        maintenanceRef.current = null;
        setUploadActive(false);
      }
      setIsUploading(false);
      wakeLock.release();
    }
  };

  const appendFiles = async (appendingFiles: FileUpload[]) => {
    if (appendingFiles.length > 0) prewarmUploadBandwidth(true);
    const additions: FileUpload[] = [];
    for (const file of appendingFiles) {
      if (
        existingFiles.some(
          (saved) =>
            !saved.deleted &&
            !saved.metadataUnreadable &&
            saved.name === file.name &&
            Number(saved.size) ===
              file.size +
                (isE2EEncrypted
                  ? Math.ceil(
                      file.size / (saved.encryptionChunkSize || 1_000_000),
                    ) * 28
                  : 0) &&
            (saved.relativePath || "") === (file.uploadRelativePath || ""),
        )
      )
        continue;
      const resumed = await matchUploadResumeEntry(
        file,
        file.uploadRelativePath,
        resumeEntries,
      );
      if (
        !resumed &&
        resumeEntries.some(
          (entry) =>
            entry.name === file.name &&
            (entry.relativePath || "") === (file.uploadRelativePath || ""),
        )
      )
        toast.error(t("upload.pending.fileChanged"));
      additions.push(file);
    }
    setUploadingFiles((previous) => [...additions, ...previous]);
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
      {(uploadPending || pendingFinalization || resumeEntries.length > 0) && (
        <Alert title={t("upload.pending.title")} color="orange" mb="lg">
          <Text size="sm">{t("upload.pending.resumeHelp")}</Text>
          {resumeEntries.length > 0 && (
            <Text size="sm" mt="xs">
              {resumeEntries.map((entry) => entry.name).join(", ")}
            </Text>
          )}
        </Alert>
      )}
      <Group justify="right" mb={20} gap="xs">
        {isUploading && (
          <Button size="sm" color="red" variant="subtle" onClick={cancelUpload}>
            <FormattedMessage
              id="upload.cancel.button"
              defaultMessage="Annuler"
            />
          </Button>
        )}
        <Button
          loading={isUploading}
          disabled={!dirty && !uploadPending && !pendingFinalization}
          onClick={() => save()}
        >
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
        <FileList
          files={existingAndUploadedFiles}
          setFiles={setFiles}
          isUploading={isUploading}
        />
      )}
    </>
  );
};
export default EditableUpload;
