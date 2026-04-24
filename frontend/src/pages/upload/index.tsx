import { Button, Group, Progress, Stack, Text, Title } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { cleanNotifications } from "@mantine/notifications";
import pLimit from "p-limit";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import Meta from "../../components/Meta";
import Dropzone from "../../components/upload/Dropzone";
import FileList from "../../components/upload/FileList";
import showCompletedUploadModal from "../../components/upload/modals/showCompletedUploadModal";
import showCreateUploadModal from "../../components/upload/modals/showCreateUploadModal";
import useConfig from "../../hooks/config.hook";
import useConfirmLeave from "../../hooks/confirm-leave.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import useUser from "../../hooks/user.hook";
import useWakeLock from "../../hooks/useWakeLock.hook";
import shareService from "../../services/share.service";
import { FileUpload } from "../../types/File.type";
import { CreateShare, Share } from "../../types/share.type";
import toast from "../../utils/toast.util";
import {
  generateEncryptionKey,
  exportKeyToBase64,
  importKeyFromBase64,
  computeKeyHash,
  getUserKey,
  storeUserKey,
  extractKeyFromHash,
} from "../../utils/crypto.util";
import userService from "../../services/user.service";
import { setUploadActive } from "../../services/api.service";
import { useRouter } from "next/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAdaptiveChunkSize,
  uploadFileViaWorker,
} from "../../utils/upload.util";
import { requestNotificationPermission } from "../../utils/safeline-notify.util";

// pLimit is created per-upload to avoid stale slot accumulation across
// uploads in the same SPA session (module-level pLimit never resets).
const DEFAULT_CONCURRENCY = 3;

let errorToastShown = false;
let createdShare: Share;
let e2eKeyEncoded: string | null = null;
let shouldShareE2EKeyViaEmail = false;

type UploadProps = {
  maxShareSize?: number;
  isReverseShare: boolean;
  isE2EEncrypted?: boolean;
  simplified: boolean;
  name?: string;
};

const Upload = ({
  maxShareSize,
  isReverseShare = false,
  isE2EEncrypted = false,
  simplified,
  name,
}: UploadProps) => {
  const modals = useModals();
  const router = useRouter();
  const t = useTranslate();

  const queryClient = useQueryClient();

  const { user } = useUser();
  const config = useConfig();
  const wakeLock = useWakeLock();
  const [files, setFiles] = useState<FileUpload[]>([]);
  const [isUploading, setisUploading] = useState(false);
  const uploadAbortRef = useRef<AbortController | null>(null);

  useConfirmLeave({
    message: t("upload.notify.confirm-leave"),
    enabled: isUploading,
  });

  // Detect tab discard: Chromium browsers (Chrome/Opera/Edge) can kill
  // background tabs via Memory Saver / RAM Limiter.  When the user
  // returns, the page reloads from scratch and any in-progress upload
  // is lost.  Show a warning so the user understands what happened.
  useEffect(() => {
    if ((document as any).wasDiscarded) {
      toast.error(
        t("upload.notify.tab-discarded", {
          defaultMessage:
            "The browser discarded this tab to save memory. " +
            "The upload in progress was interrupted. Please restart the upload. " +
            "Tip: keep this tab in the foreground during large uploads, " +
            "or disable the memory saver for this site.",
        }),
        { withCloseButton: true, autoClose: false },
      );
    }
  }, []);

  // Reset the API-layer upload guard if this component unmounts (e.g.
  // when the user forces navigation past the confirm-leave dialog).
  useEffect(() => {
    return () => {
      setUploadActive(false);
      webLockReleaseRef.current?.();
      webLockReleaseRef.current = null;
    };
  }, []);

  const enableRecipientRetrieval =
    !isReverseShare &&
    config.get("email.enableShareEmailRecipients") &&
    config.get("email.enableShareEmailPastRecipients") &&
    !!user;

  const { data: pastRecipients } = useQuery({
    queryKey: ["share.pastRecipients"],
    queryFn: () => shareService.getStoredRecipients(),
    enabled: enableRecipientRetrieval,
    refetchInterval: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });

  const chunkSize = useRef(parseInt(config.get("share.chunkSize")));
  const keepaliveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reverse-share pages pass maxShareSize as prop; otherwise use config limit
  const effectiveMaxShareSize =
    maxShareSize ?? parseInt(config.get("share.maxSize"));

  const autoOpenCreateUploadModal = config.get("share.autoOpenShareModal");

  // Web Lock: signals the browser that this tab is doing critical work,
  // preventing Chromium (Chrome/Opera/Edge) from discarding it in the
  // background via Memory Saver / RAM Limiter.
  const webLockReleaseRef = useRef<(() => void) | null>(null);

  const uploadFiles = async (share: CreateShare, files: FileUpload[]) => {
    setisUploading(true);
    setUploadActive(true);
    shouldShareE2EKeyViaEmail = !!share.shareE2EKeyViaEmail;

    // Request browser notification permission (requires user gesture).
    // If granted, SafeLine 468 challenges will fire an OS-level popup
    // and audio beep even when this tab is in the background.
    requestNotificationPermission();

    const abortCtrl = new AbortController();
    uploadAbortRef.current = abortCtrl;

    // Keep screen awake during upload (mobile)
    await wakeLock.acquire();

    // Acquire a Web Lock to prevent tab discarding (Chromium browsers).
    // The lock is held until the returned release function is called.
    if (typeof navigator.locks !== "undefined") {
      navigator.locks.request(
        "privcloud-upload-active",
        { mode: "exclusive" },
        () =>
          new Promise<void>((resolve) => {
            webLockReleaseRef.current = resolve;
          }),
      );
    }

    // Start SW keepalive to prevent browser from killing background uploads
    let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
    if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
      keepaliveInterval = setInterval(() => {
        navigator.serviceWorker.controller?.postMessage({
          type: "UPLOAD_KEEPALIVE",
        });
      }, 20000);
      keepaliveRef.current = keepaliveInterval;
    }

    // --- E2E: retrieve or create the encryption key ---
    let cryptoKey: CryptoKey | null = null;
    let storedKey = user ? getUserKey() : null;

    if (isReverseShare && isE2EEncrypted) {
      // Reverse share E2E: read K_rs from the URL fragment
      const rsKeyEncoded = extractKeyFromHash();
      if (rsKeyEncoded) {
        cryptoKey = await importKeyFromBase64(rsKeyEncoded);
        e2eKeyEncoded = rsKeyEncoded;
        share.isE2EEncrypted = true;
      } else {
        // Key absent from fragment -> no encryption
        e2eKeyEncoded = null;
      }
    } else if (user) {
      if (storedKey) {
        // Existing key -> reuse
        cryptoKey = await importKeyFromBase64(storedKey);
        e2eKeyEncoded = storedKey;
      } else {
        // First use -> generate, store and register the hash
        cryptoKey = await generateEncryptionKey();
        e2eKeyEncoded = await exportKeyToBase64(cryptoKey);
        storeUserKey(e2eKeyEncoded);
        const hash = await computeKeyHash(cryptoKey, user!.id);
        await userService.setEncryptionKeyHash(hash);
      }
      share.isE2EEncrypted = true;
    } else {
      // Anonymous upload (no reverse share): no E2E encryption --
      // there is no account to store the key and no URL fragment
      // mechanism for anonymous classic shares.
      cryptoKey = null;
      e2eKeyEncoded = null;
      share.isE2EEncrypted = false;
    }

    try {
      const isReverseShare = router.pathname != "/upload";
      createdShare = await shareService.create(share, isReverseShare);
    } catch (e) {
      toast.axiosError(e);
      setisUploading(false);
      setUploadActive(false);
      webLockReleaseRef.current?.();
      webLockReleaseRef.current = null;
      wakeLock.release();
      e2eKeyEncoded = null;
      return;
    }

    // Store the key locally for the owner (already done via storeUserKey above)

    // --- Adaptive chunk sizing ---
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const effectiveChunkSize = await getAdaptiveChunkSize(chunkSize.current);

    const isLargeUpload = totalSize > 2_000_000_000;
    const uploadLimit = pLimit(isLargeUpload ? 1 : DEFAULT_CONCURRENCY);

    // Proactive SafeLine keepalive: periodically GET the main page
    // to keep the WAF session cookie alive during long uploads.
    // If the cookie is still valid, SafeLine passes the request
    // through and may extend the session.  90s interval keeps the
    // session fresh even for multi-hour uploads.
    const safelineKeepalive = setInterval(() => {
      fetch("/?_sl=" + Date.now(), { credentials: "include" })
        .then((r) => {
          r.body?.cancel();
        })
        .catch(() => {});
    }, 90_000); // every 90s

    // --- Upload via dedicated Web Worker ---
    // The entire slice + encrypt + fetch loop runs inside a Worker
    // with its own V8 heap.  All per-chunk allocations (AbortController,
    // fetch Promise chain, Response, encrypted ArrayBuffers) live in
    // the Worker and never accumulate on the main renderer process.
    // This is the primary fix for OOM/SIGTRAP during >10 GB uploads.

    const fileUploadPromises = files.map((file, fileIndex) =>
      uploadLimit(async () => {
        let chunks = Math.ceil(file.size / effectiveChunkSize);
        if (chunks == 0) chunks++;
        const progressInterval = Math.max(1, Math.floor(chunks / 200));

        const setFileProgress = (progress: number) => {
          setFiles((prev) =>
            prev.map((file, callbackIndex) => {
              if (fileIndex == callbackIndex) {
                file.uploadingProgress = progress;
              }
              return file;
            }),
          );
        };

        setFileProgress(1);

        try {
          await uploadFileViaWorker(
            file,
            createdShare.id,
            effectiveChunkSize,
            chunks,
            share.isE2EEncrypted ?? false,
            cryptoKey,
            (chunkIndex, totalChunks, _fileId) => {
              // Throttled progress update -- only re-render React
              // every progressInterval chunks, plus always on last.
              if (
                chunkIndex % progressInterval === 0 ||
                chunkIndex === totalChunks - 1
              ) {
                setFileProgress(((chunkIndex + 1) / totalChunks) * 100);
              }
            },
            abortCtrl.signal,
          );
        } catch (e: any) {
          if (e?.cancelled) return; // user cancelled -- skip error toast
          if (e?.quota) {
            toast.error(e.message || "Upload failed (quota limit)");
          } else if (e?.status === 413) {
            toast.error(e?.data?.message || "Upload failed (size limit)");
          } else if (e?.status === 403) {
            toast.error(e?.data?.message || "Upload failed (access denied)");
          }
          setFileProgress(-1);
        }
      }),
    );

    Promise.all(fileUploadPromises)
      .catch(() => {})
      .finally(() => {
        clearInterval(safelineKeepalive);
      });
  };

  const cancelUpload = () => {
    modals.openConfirmModal({
      title: t("upload.cancel.title", { defaultMessage: "Cancel upload" }),
      children: (
        <Text size="sm">
          <FormattedMessage
            id="upload.cancel.confirm"
            defaultMessage="The upload in progress will be interrupted and the incomplete share deleted. Continue?"
          />
        </Text>
      ),
      labels: {
        confirm: t("common.button.confirm", { defaultMessage: "Confirm" }),
        cancel: t("common.button.cancel", { defaultMessage: "No" }),
      },
      confirmProps: { color: "red" },
      onConfirm: () => {
        // 1. Abort all in-flight uploads
        uploadAbortRef.current?.abort();
        uploadAbortRef.current = null;

        // 2. Delete the incomplete share (best-effort)
        if (createdShare?.id) {
          shareService.remove(createdShare.id).catch(() => {});
        }

        // 3. Reset state
        if (keepaliveRef.current) {
          clearInterval(keepaliveRef.current);
          keepaliveRef.current = null;
        }
        wakeLock.release();
        setisUploading(false);
        setUploadActive(false);
        webLockReleaseRef.current?.();
        webLockReleaseRef.current = null;
        setFiles((prev) =>
          prev.map((f) => {
            if (f.uploadingProgress !== undefined && f.uploadingProgress < 100) {
              f.uploadingProgress = -1;
            }
            return f;
          }),
        );
        e2eKeyEncoded = null;
        shouldShareE2EKeyViaEmail = false;
        toast.error(t("upload.cancel.done", { defaultMessage: "Upload cancelled" }));
      },
    });
  };

  const showCreateUploadModalCallback = (files: FileUpload[]) => {
    showCreateUploadModal(
      modals,
      {
        isUserSignedIn: user ? true : false,
        isReverseShare,
        allowUnauthenticatedShares: config.get(
          "share.allowUnauthenticatedShares",
        ),
        enableEmailRecepients: config.get("email.enableShareEmailRecipients"),
        enableE2EKeyEmailSharing: config.get("email.enableE2EKeyEmailSharing"),
        maxExpiration: config.get("share.maxExpiration"),
        anonymousMaxExpiration: config.get("share.anonymousMaxExpiration"),
        shareIdLength: config.get("share.shareIdLength"),
        simplified,
        captchaSiteKey:
          !user && config.get("hcaptcha.enabled")
            ? config.get("hcaptcha.siteKey")
            : undefined,
      },
      files,
      uploadFiles,
      pastRecipients,
    );
  };

  const handleDropzoneFilesChanged = (files: FileUpload[]) => {
    if (autoOpenCreateUploadModal) {
      setFiles(files);
      showCreateUploadModalCallback(files);
    } else {
      setFiles((oldArr) => [...oldArr, ...files]);
    }
  };

  useEffect(() => {
    // Check if there are any files that failed to upload
    const fileErrorCount = files.filter(
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

    // Complete share
    if (
      files.length > 0 &&
      files.every((file) => file.uploadingProgress >= 100) &&
      fileErrorCount == 0
    ) {
      // For reverse shares the backend always needs K_rs so the reverse share
      // creator can receive a working link.  For classic shares, the key is
      // only included when the uploader opted in via the checkbox.
      // For anonymous shares the key is ephemeral (no localStorage), so
      // we always include it when recipients are configured.
      const isReverseShareUpload = router.pathname !== "/upload";
      const isAnonymousUpload = !user;
      const e2eKeyForComplete =
        ((shouldShareE2EKeyViaEmail || isReverseShareUpload || isAnonymousUpload) && e2eKeyEncoded)
          ? e2eKeyEncoded
          : undefined;
      shareService
        .completeShare(createdShare.id, e2eKeyForComplete)
        .then((share) => {
          if (keepaliveRef.current) {
            clearInterval(keepaliveRef.current);
            keepaliveRef.current = null;
          }
          wakeLock.release();
          setisUploading(false);
          setUploadActive(false);
          webLockReleaseRef.current?.();
          webLockReleaseRef.current = null;
          showCompletedUploadModal(modals, share, e2eKeyEncoded);
          queryClient.invalidateQueries({
            queryKey: ["share.pastRecipients"],
          });
          setFiles([]);
          e2eKeyEncoded = null;
          shouldShareE2EKeyViaEmail = false;
        })
        .catch(() => toast.error(t("upload.notify.generic-error")));
    }

    // All files finished but some (or all) failed -- reset upload state
    // so the UI is no longer stuck in "uploading" mode.
    const allFilesDone =
      files.length > 0 &&
      isUploading &&
      files.every(
        (f) => f.uploadingProgress >= 100 || f.uploadingProgress === -1,
      );
    if (allFilesDone && fileErrorCount > 0) {
      if (keepaliveRef.current) {
        clearInterval(keepaliveRef.current);
        keepaliveRef.current = null;
      }
      wakeLock.release();
      setisUploading(false);
      setUploadActive(false);
      webLockReleaseRef.current?.();
      webLockReleaseRef.current = null;
    }
  }, [files]);

  return (
    <>
      <Meta title={t("upload.title")} />
      <Group
        {...(name ? { position: "apart" } : { position: "right" })}
        mb={20}
      >
        {name && <Title order={3}>{name}</Title>}
        <Button
          loading={isUploading}
          disabled={files.length <= 0}
          onClick={() => showCreateUploadModalCallback(files)}
        >
          <FormattedMessage id="common.button.share" />
        </Button>
      </Group>
      <Dropzone
        title={
          !autoOpenCreateUploadModal && files.length > 0
            ? t("share.edit.append-upload")
            : undefined
        }
        maxShareSize={effectiveMaxShareSize}
        existingFilesSize={files.reduce((sum, f) => sum + f.size, 0)}
        onFilesChanged={handleDropzoneFilesChanged}
        isUploading={isUploading}
      />
      {isUploading && files.length > 0 && (() => {
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        const uploadedSize = files.reduce((sum, f) => {
          const pct = Math.max(0, f.uploadingProgress ?? 0);
          return sum + (f.size * Math.min(pct, 100)) / 100;
        }, 0);
        const globalPct = totalSize > 0 ? Math.round((uploadedSize / totalSize) * 100) : 0;
        const done = files.filter((f) => f.uploadingProgress >= 100).length;
        const failed = files.filter((f) => f.uploadingProgress === -1).length;
        return (
          <Stack spacing={4} mt="sm" mb="xs">
            <Group position="apart">
              <Text size="sm" weight={500}>
                <FormattedMessage
                  id="upload.progress.global"
                  defaultMessage="Upload: {done}/{total} files"
                  values={{ done: done + failed, total: files.length }}
                />
              </Text>
              <Group spacing="xs">
                <Text size="sm" color="dimmed">{globalPct}%</Text>
                <Button
                  size="xs"
                  compact
                  color="red"
                  variant="subtle"
                  onClick={cancelUpload}
                >
                  <FormattedMessage
                    id="upload.cancel.button"
                    defaultMessage="Cancel"
                  />
                </Button>
              </Group>
            </Group>
            <Progress
              value={globalPct}
              size="lg"
              radius="xl"
              animate={globalPct < 100}
            />
          </Stack>
        );
      })()}
      {files.length > 0 && (
        <FileList<FileUpload> files={files} setFiles={setFiles} />
      )}
    </>
  );
};
export default Upload;
