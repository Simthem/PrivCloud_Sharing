import { Button, Group, Progress, Stack, Text, Title, Alert } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { cleanNotifications, showNotification } from "@mantine/notifications";
import pLimit from "p-limit";
import { useEffect, useRef, useState, useCallback } from "react";
import { FormattedMessage } from "react-intl";
import { TbInfoCircle, TbFolder } from "react-icons/tb";
import { TbCloudDownload, TbCloudUpload } from "react-icons/tb";
import Meta from "../../components/Meta";
import Dropzone from "../../components/upload/Dropzone";
import FileList from "../../components/upload/FileList";
import WebDavImportModal from "../../components/upload/WebDavImportModal";
import showCompletedUploadModal from "../../components/upload/modals/showCompletedUploadModal";
import showCreateUploadModal from "../../components/upload/modals/showCreateUploadModal";
import useConfig from "../../hooks/config.hook";
import useConfirmLeave from "../../hooks/confirm-leave.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import useUser from "../../hooks/user.hook";
import useWakeLock from "../../hooks/useWakeLock.hook";
import shareService from "../../services/share.service";
import {
  startBridgeWebDavUploadJob,
  waitForBridgeUploadJob,
} from "../../services/privcloudBridge.service";
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
  unwrapReverseShareKey,
} from "../../utils/crypto.util";
import userService from "../../services/user.service";
import teamService from "../../services/team.service";
import { setUploadActive, completeSafeLineChallenge } from "../../services/api.service";
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

const isBridgeWebDavUploadFile = (file: FileUpload) =>
  !!file.privcloudBridgeSource;

const bridgeBatchKey = (file: FileUpload) => {
  const source = file.privcloudBridgeSource;
  if (!source) return "";
  return JSON.stringify([source.endpoint, source.username, source.password]);
};

const translateBridgeUploadError = (
  message: string | undefined,
  t: ReturnType<typeof useTranslate>,
) => {
  if (!message) return t("bridge.error.internal");
  if (
    message.startsWith("bridge.") ||
    message.startsWith("webdav.") ||
    message.startsWith("upload.")
  ) {
    return t(message);
  }
  if (message.includes("Too many active Bridge jobs")) {
    return t("bridge.error.tooManyJobs");
  }
  if (message.includes("Select between 1 and")) {
    return t("bridge.error.fileSelectionLimit");
  }
  return message;
};

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

  // Pre-selected team folder from query params (from the folder page "Upload" button)
  const qTeamFolderId = typeof router.query.teamFolderId === "string" ? router.query.teamFolderId : undefined;
  const { data: writableFolders } = useQuery({
    queryKey: ["myWritableFolders"],
    queryFn: teamService.getMyWritableFolders,
    enabled: !!user && !!qTeamFolderId,
    staleTime: 60_000,
  });
  const targetFolderInfo = qTeamFolderId
    ? writableFolders?.find((wf) => wf.folder.id === qTeamFolderId)
    : undefined;
  const [files, setFiles] = useState<FileUpload[]>([]);
  const [isUploading, setisUploading] = useState(false);
  const [webDavOpened, setWebDavOpened] = useState(false);
  const uploadAbortRef = useRef<AbortController | null>(null);

  // ---- Browser-setup banner (popups + notifications) ----
  // Dismissible: stored in localStorage with a 30-day snooze so the user
  // isn't nagged on every login. The banner reappears after 30 days or
  // if the user clears localStorage - but never on every page visit.
  const DISMISS_KEY = "privcloud_browser_setup_dismissed";
  const DISMISS_DAYS = 30;

  // SSR-safe: always start with the same defaults the server produces.
  // Real values are read from localStorage / Notification API in a
  // useEffect below, after hydration, to avoid React #418/#423.
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // Popup permission state. Cached in localStorage so the intrusive
  // window.open probe only runs ONCE (or when the user clicks "Test
  // pop-ups" manually).  Re-probed after DISMISS_DAYS or on cache miss.
  const POPUP_CACHE_KEY = "privcloud_popup_probe";
  const POPUP_CACHE_DAYS = 30;
  const [popupsAllowed, setPopupsAllowed] = useState(true);

  // Browser notification permission state.
  // "unsupported" covers browsers where the API is absent (e.g. Brave
  // with shields up, older WebViews) - we skip the notification section
  // entirely for these.
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">("unsupported");

  // Hydrate browser-specific state after mount (avoids SSR mismatch).
  useEffect(() => {
    // Banner dismiss
    const rawDismiss = localStorage.getItem(DISMISS_KEY);
    if (rawDismiss) {
      const ts = parseInt(rawDismiss, 10);
      if (!isNaN(ts) && Date.now() - ts < DISMISS_DAYS * 86_400_000) {
        setBannerDismissed(true);
      }
    }

    // Popup cache: only trust a cached "true" result.
    // On WebKit (Safari, Epiphany, GNOME Web…) window.open probes are
    // unreliable (succeed silently even when popups are blocked), so we
    // assume popups are NOT proven until the user clicks the test button.
    const rawPopup = localStorage.getItem(POPUP_CACHE_KEY);
    if (rawPopup) {
      try {
        const { value, ts } = JSON.parse(rawPopup);
        if (Date.now() - ts <= POPUP_CACHE_DAYS * 86_400_000) {
          setPopupsAllowed(value === true);
        }
        // expired -> stays at default (true), will be re-probed below
      } catch { /* ignore */ }
    }

    // Notification permission
    if (typeof Notification !== "undefined") {
      setNotifPermission(Notification.permission);
    }
  }, []);

  // Probe popup permission once on mount if no cached result exists (or expired).
  // The result is persisted in localStorage so this flash only happens once.
  // On WebKit (Safari, Epiphany, GNOME Web…) the window.open probe is
  // unreliable - it succeeds silently even when popups are blocked.
  // So we skip auto-probing on WebKit; the user must click "Test pop-ups".
  useEffect(() => {
    if (!user || router.pathname !== "/upload") return;

    // Detect WebKit-only browsers (no Chrome/Chromium layer).
    // Chrome on iOS also has AppleWebKit but includes "Chrome" in UA.
    const ua = navigator.userAgent;
    const isWebKit =
      /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR|Brave/.test(ua);

    // If WebKit and no cached positive result, assume unverified -> show banner.
    if (isWebKit) {
      const raw = localStorage.getItem(POPUP_CACHE_KEY);
      if (raw) {
        try {
          const { value, ts } = JSON.parse(raw);
          if (Date.now() - ts < POPUP_CACHE_DAYS * 86_400_000 && value === true) return; // user already confirmed
        } catch { /* fall through */ }
      }
      setPopupsAllowed(false);
      return;
    }

    // Non-WebKit: auto-probe with window.open
    // Check if we have a fresh cached result
    const raw = localStorage.getItem(POPUP_CACHE_KEY);
    if (raw) {
      try {
        const { ts } = JSON.parse(raw);
        if (Date.now() - ts < POPUP_CACHE_DAYS * 86_400_000) return; // still fresh
      } catch { /* fall through to re-probe */ }
    }
    try {
      const probe = window.open("about:blank", "_blank", "width=1,height=1,left=-9999,top=-9999");
      if (probe) {
        probe.close();
        setPopupsAllowed(true);
        localStorage.setItem(POPUP_CACHE_KEY, JSON.stringify({ value: true, ts: Date.now() }));
      } else {
        setPopupsAllowed(false);
        localStorage.setItem(POPUP_CACHE_KEY, JSON.stringify({ value: false, ts: Date.now() }));
      }
    } catch {
      setPopupsAllowed(false);
      localStorage.setItem(POPUP_CACHE_KEY, JSON.stringify({ value: false, ts: Date.now() }));
    }
  }, [user, router.pathname]);

  const notifActionable = notifPermission === "default";
  // "denied" is permanent in most browsers (no re-prompt possible) - we
  // also hide the section to avoid frustrating the user with a dead button.
  const notifHidden = notifPermission === "unsupported" || notifPermission === "denied";
  const showNotifPrompt = notifActionable && !notifHidden;

  // Show the banner for authenticated users when there is something
  // actionable (popups blocked OR notifications promptable), unless dismissed.
  const showBrowserSetup = !!user && !bannerDismissed && (!popupsAllowed || showNotifPrompt);

  const handleDismissBanner = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setBannerDismissed(true);
  }, []);

  const handleRequestNotifPermission = useCallback(async () => {
    try {
      const result = await Notification.requestPermission();
      setNotifPermission(result);
    } catch {
      // Old Safari callback-style API
      Notification.requestPermission((result) => setNotifPermission(result));
    }
  }, []);

  const handleTestPopup = useCallback(() => {
    try {
      const win = window.open("about:blank", "_blank", "width=1,height=1,left=-9999,top=-9999");
      if (win) {
        win.close();
        setPopupsAllowed(true);
        localStorage.setItem(POPUP_CACHE_KEY, JSON.stringify({ value: true, ts: Date.now() }));
      } else {
        toast.error(t("upload.browser-setup.popup-still-blocked"));
      }
    } catch {
      toast.error(t("upload.browser-setup.popup-still-blocked"));
    }
  }, [t]);

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
            "Le navigateur a decharge cet onglet pour economiser de la memoire. " +
            "L'envoi en cours a ete interrompu. Veuillez relancer l'envoi. " +
            "Astuce : gardez cet onglet au premier plan pendant les gros envois, " +
            "ou desactivez l'economiseur de memoire pour ce site.",
        }),
        { autoClose: false },
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Fetch configured upload limit (optional instance policy)
  const { data: configuredMaxShareSize } = useQuery({
    queryKey: ["uploadLimit", user?.id],
    queryFn: async () => ({ maxSize: 0, usedSize: 0 }), // 0 = no configured limit
    // Reverse-share upload must always use reverseShare.maxShareSize,
    // never the current client's configured/anonymous cap.
    enabled: !isReverseShare,
    refetchInterval: Infinity,
    refetchOnWindowFocus: false,
  });

  // Fetch configured expiration limit (unlimited by default)
  const { data: configuredMaxExpirationDays } = useQuery({
    queryKey: ["expirationLimit", user?.id],
    queryFn: async () => ({ maxDays: 0 }),
    enabled: !isReverseShare,
    refetchInterval: Infinity,
    refetchOnWindowFocus: false,
  });

  // Reverse-share pages pass maxShareSize as prop; otherwise use configured limit
  // 0 means unlimited (no configured limit)
  const rawEffectiveMaxShareSize =
    maxShareSize ?? configuredMaxShareSize?.maxSize ?? parseInt(config.get("share.maxSize"));
  const effectiveMaxShareSize =
    rawEffectiveMaxShareSize === 0 ? Number.MAX_SAFE_INTEGER : rawEffectiveMaxShareSize;

  const autoOpenCreateUploadModal = config.get("share.autoOpenShareModal");
  const canUseWebDav = !!user && !isReverseShare;

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

    // NOTE: SW keepalive removed -- it was keeping Chrome's ServiceWorker
    // thread alive for hours which triggered UD2 / IMMEDIATE_CRASH in
    // Chrome's SW lifetime manager

    // --- E2E: read or create the encryption key ---
    let cryptoKey: CryptoKey | null = null;
    let storedKey = user ? getUserKey() : null;

    if (isReverseShare && isE2EEncrypted) {
      // Reverse share E2E : lire K_rs depuis le fragment d'URL
      const rsKeyEncoded = extractKeyFromHash();
      if (rsKeyEncoded) {
        cryptoKey = await importKeyFromBase64(rsKeyEncoded);
        e2eKeyEncoded = rsKeyEncoded;
        share.isE2EEncrypted = true;
      } else {
        // Missing fragment key: upload without encryption.
        e2eKeyEncoded = null;
      }
    } else if (user && share.teamFolderId) {
      // Team folder upload: use K_team instead of K_user
      try {
        const userKeyB64 = getUserKey();
        if (userKeyB64) {
          // Find which team this folder belongs to
          const writableFolders = await teamService.getMyWritableFolders();
          const match = writableFolders.find(
            (wf) => wf.folder.id === share.teamFolderId,
          );
          if (match) {
            const { wrappedTeamKey } = await teamService.getTeamKey(match.teamId);
            if (wrappedTeamKey) {
              const masterKey = await importKeyFromBase64(userKeyB64);
              cryptoKey = await unwrapReverseShareKey(wrappedTeamKey, masterKey);
              e2eKeyEncoded = await exportKeyToBase64(cryptoKey);
              share.isE2EEncrypted = true;
            } else {
              // No team key set yet - team E2E not configured.
              // DO NOT fallback to user key: it would create files that
              // other team members cannot decrypt.  Upload unencrypted.
              cryptoKey = null;
              e2eKeyEncoded = null;
              share.isE2EEncrypted = false;
            }
          }
        }
      } catch (e) {
        // Team key unwrap failed (user key was regenerated, localStorage
        // cleared, or new device).  DO NOT fallback to user key - that
        // would produce files encrypted with K_user that other team
        // members cannot decrypt (OperationError on their side).
        // Instead, upload without encryption and warn the user.
        console.warn("[E2E] Team key unwrap failed - uploading without encryption:", e);
        cryptoKey = null;
        e2eKeyEncoded = null;
        share.isE2EEncrypted = false;
        toast.error(
          "Impossible de déverrouiller la clé de chiffrement de l'équipe. " +
          "L'envoi se poursuit sans chiffrement E2E. " +
          "Demandez à un administrateur de l'équipe de resynchroniser votre clé.",
        );
      }
    } else if (user) {
      if (storedKey) {
        // Existing key: reuse it.
        cryptoKey = await importKeyFromBase64(storedKey);
        e2eKeyEncoded = storedKey;
      } else {
        // First use: generate, store and register the hash.
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

    // The owner key is stored locally by storeUserKey above.

    // --- Adaptive chunk sizing ---
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    // Pass the largest individual file size so chunk sizing guarantees
    // we never exceed S3's 10,000-part limit for any single file.
    const maxFileSize = Math.max(...files.map((f) => f.size));
    const effectiveChunkSize = await getAdaptiveChunkSize(
      chunkSize.current,
      maxFileSize,
    );
    let bridgeUploadToken: { token: string; expiresAt: string } | null = null;
    if (files.some(isBridgeWebDavUploadFile)) {
      try {
        bridgeUploadToken = await shareService.createBridgeUploadToken(
          createdShare.id,
          "WebDAV Bridge import",
        );
      } catch (e) {
        toast.axiosError(e);
        await shareService.remove(createdShare.id).catch(() => undefined);
        setisUploading(false);
        setUploadActive(false);
        webLockReleaseRef.current?.();
        webLockReleaseRef.current = null;
        wakeLock.release();
        e2eKeyEncoded = null;
        return;
      }
    }

    const isLargeUpload = totalSize > 2_000_000_000;
    // Allow 2 concurrent files even for large uploads when there are
    // multiple files -- keeps the connection pipeline busy while one
    // chunk finishes and the next starts.  Single-file uploads stay
    // at 1 (no benefit from concurrency with sequential chunks).
    const concurrency = isLargeUpload
      ? Math.min(2, files.length)
      : DEFAULT_CONCURRENCY;
    const uploadLimit = pLimit(concurrency);

    // Proactive SafeLine keepalive: periodically GET the main page
    // to keep the WAF session cookie alive during long uploads.
    // If the cookie is still valid, SafeLine passes the request
    // through and may extend the session.  60s interval keeps the
    // session fresh even for multi-hour uploads.
    //
    // STRATEGY: Ping every 30s (SafeLine default session is typically
    // 30-60 min, but we don't control it).  On 468, immediately solve
    // via iframe (no popup needed = no user gesture needed = 100% silent).
    // This makes the challenge invisible to the user in most cases.
    let safelineKeepaliveResolving = false;
    keepaliveRef.current = setInterval(async () => {
      if (safelineKeepaliveResolving) return; // already resolving
      try {
        const r = await fetch("/?_sl=" + Date.now(), {
          credentials: "include",
          cache: "no-store",
          // 10s timeout: don't let keepalive hang if network is saturated
          signal: AbortSignal.timeout(10_000),
        });
        if (r.status === 468) {
          // Session expired - resolve silently via iframe
          safelineKeepaliveResolving = true;
          try {
            await completeSafeLineChallenge();
          } catch {
            // iframe + popup both failed - worker retry will handle it
          } finally {
            safelineKeepaliveResolving = false;
          }
        } else {
          r.body?.cancel();
        }
      } catch {
        // Network/timeout error - ignore, chunk requests will handle it
      }
    }, 30_000); // every 30s - aggressive enough to catch any session TTL

    // --- Upload via dedicated Web Worker ---
    // The entire slice + encrypt + fetch loop runs inside a Worker
    // with its own V8 heap.  All per-chunk allocations (AbortController,
    // fetch Promise chain, Response, encrypted ArrayBuffers) live in
    // the Worker and never accumulate on the main renderer process.
    // This is the primary fix for OOM/SIGTRAP during >10 GB uploads.

    // --- File upload with skip-and-retry ---
    // Strategy: process all files through pLimit.  If a file fails with
    // a retryable error, it releases its pLimit slot immediately (so
    // other queued files can start) and is pushed to a retry queue.
    // After all first-attempt files complete, retry the failed ones
    // sequentially with increasing delays.  This prevents cascade
    // failures: if SafeLine blocks one file, the others don't wait.
    const MAX_FILE_RETRIES = 3;
    const FILE_RETRY_DELAYS = [30_000, 60_000, 120_000]; // 30s, 60s, 2min

    const isRetryableError = (err: any): boolean => {
      if (err?.cancelled) return false;
      if (err?.quota) return false;
      if (err?.status === 413) return false;
      if (err?.status === 403 && err?.data?.error) return false;
      if (err?.message && /crypto|key import/i.test(err.message)) return false;
      return true;
    };

    const fileAttempts = new Map<number, number>();
    const retryQueue: Array<{ file: (typeof files)[0]; fileIndex: number }> = [];
    const bridgeBatches = new Map<
      string,
      Array<{ file: (typeof files)[0]; fileIndex: number }>
    >();
    const bridgeBatchLeaders = new Map<string, number>();

    files.forEach((file, fileIndex) => {
      if (!isBridgeWebDavUploadFile(file)) return;
      const key = bridgeBatchKey(file);
      const batch = bridgeBatches.get(key) ?? [];
      batch.push({ file, fileIndex });
      bridgeBatches.set(key, batch);
      if (!bridgeBatchLeaders.has(key)) {
        bridgeBatchLeaders.set(key, fileIndex);
      }
    });

    const uploadSingleFile = async (
      file: (typeof files)[0],
      fileIndex: number,
    ): Promise<"ok" | "failed" | "retryable"> => {
      const attempt = fileAttempts.get(fileIndex) ?? 0;
      fileAttempts.set(fileIndex, attempt + 1);

      let chunks = Math.ceil(file.size / effectiveChunkSize);
      if (chunks == 0) chunks++;
      const progressInterval = Math.max(1, Math.floor(chunks / 200));
      let completedChunks = 0;

      const setFileProgress = (progress: number) => {
        setFiles((prev) =>
          prev.map((f, callbackIndex) => {
            if (fileIndex == callbackIndex) {
              f.uploadingProgress = progress;
            }
            return f;
          }),
        );
      };

      if (attempt > 0) completedChunks = 0;
      setFileProgress(1);

      try {
        if (isBridgeWebDavUploadFile(file)) {
          const source = file.privcloudBridgeSource!;
          const batch =
            bridgeBatches.get(bridgeBatchKey(file)) ?? [{ file, fileIndex }];
          const batchIndexes = new Set(batch.map(({ fileIndex }) => fileIndex));
          setFiles((prev) =>
            prev.map((f, callbackIndex) => {
              if (batchIndexes.has(callbackIndex)) {
                f.uploadingProgress = 1;
              }
              return f;
            }),
          );
          if (!bridgeUploadToken) {
            throw new Error("Bridge upload token is missing");
          }
          if (share.isE2EEncrypted && !e2eKeyEncoded) {
            throw new Error("E2E key is missing for Bridge upload");
          }

          const job = await startBridgeWebDavUploadJob({
            appBaseUrl: window.location.origin,
            shareId: createdShare.id,
            uploadToken: bridgeUploadToken.token,
            chunkSize: effectiveChunkSize,
            isE2EEncrypted: share.isE2EEncrypted ?? false,
            encryptionKey: share.isE2EEncrypted ? e2eKeyEncoded : undefined,
            webdav: {
              endpoint: source.endpoint,
              username: source.username,
              password: source.password,
            },
            files: batch.map(({ file: batchFile }) => {
              const batchSource = batchFile.privcloudBridgeSource!;
              return {
                href: batchSource.href,
                name: batchFile.name,
                size: batchFile.size,
                contentType: batchSource.contentType || batchFile.type,
                lastModified: batchSource.lastModified,
              };
            }),
          });

          await waitForBridgeUploadJob(job.id, {
            signal: abortCtrl.signal,
            onProgress: (currentJob) => {
              const progressByIndex = new Map<number, number>();
              batch.forEach(({ file: batchFile, fileIndex: batchIndex }, i) => {
                const remote = currentJob.files[i];
                const uploaded = remote?.uploadedBytes ?? 0;
                const total = Math.max(remote?.size ?? batchFile.size, 1);
                const completed = remote?.state === "completed";
                const failed = remote?.state === "failed";
                let progress = Math.min(
                  99,
                  Math.max(1, (uploaded / total) * 100),
                );
                if (currentJob.state === "completed" || completed) {
                  progress = 100;
                } else if (failed) {
                  progress = -1;
                }
                progressByIndex.set(batchIndex, progress);
              });
              setFiles((prev) =>
                prev.map((f, callbackIndex) => {
                  const progress = progressByIndex.get(callbackIndex);
                  if (progress !== undefined) {
                    f.uploadingProgress = progress;
                  }
                  return f;
                }),
              );
            },
          });
          setFiles((prev) =>
            prev.map((f, callbackIndex) => {
              if (batchIndexes.has(callbackIndex)) {
                f.uploadingProgress = 100;
              }
              return f;
            }),
          );
        } else {
          await uploadFileViaWorker(
            file,
            createdShare.id,
            effectiveChunkSize,
            chunks,
            share.isE2EEncrypted ?? false,
            cryptoKey,
            (chunkIndex, totalChunks, _fileId) => {
              completedChunks++;
              if (
                completedChunks % progressInterval === 0 ||
                completedChunks === totalChunks
              ) {
                setFileProgress((completedChunks / totalChunks) * 100);
              }
            },
            abortCtrl.signal,
          );
        }
        setFileProgress(100);
        return "ok";
      } catch (e: any) {
        if (e?.cancelled) return "failed";
        if (isBridgeWebDavUploadFile(file)) {
          const batch =
            bridgeBatches.get(bridgeBatchKey(file)) ?? [{ file, fileIndex }];
          const batchIndexes = new Set(batch.map(({ fileIndex }) => fileIndex));
          setFiles((prev) =>
            prev.map((f, callbackIndex) => {
              if (batchIndexes.has(callbackIndex)) {
                f.uploadingProgress = -1;
              }
              return f;
            }),
          );
          toast.error(
            t("upload.bridge.error", {
              fileName: file.name,
              error: translateBridgeUploadError(e?.message, t),
            }),
          );
          setFileProgress(-1);
          return "failed";
        }
        if (!isRetryableError(e) || attempt >= MAX_FILE_RETRIES) {
          if (e?.quota) {
            toast.error(e.message || "Upload failed (quota limit)");
          } else if (e?.status === 413) {
            toast.error(e?.data?.message || "Upload failed (size limit)");
          } else if (e?.status === 403) {
            toast.error(e?.data?.message || "Upload failed (access denied)");
          } else {
            toast.error(
              `${file.name}: échec après ${attempt + 1} tentative(s) - ${e?.message || "erreur inconnue"}`,
            );
          }
          setFileProgress(-1);
          return "failed";
        }
        // Mark as retryable - slot will be freed
        setFileProgress(0);
        return "retryable";
      }
    };

    // Phase 1: initial pass - all files through pLimit
    const fileUploadPromises = files
      .map((file, fileIndex) => {
        if (
          isBridgeWebDavUploadFile(file) &&
          bridgeBatchLeaders.get(bridgeBatchKey(file)) !== fileIndex
        ) {
          return null;
        }
        return uploadLimit(async () => {
          if (abortCtrl.signal.aborted) return;
          const result = await uploadSingleFile(file, fileIndex);
          if (result === "retryable") {
            retryQueue.push({ file, fileIndex });
          }
        });
      })
      .filter((promise): promise is Promise<void> => !!promise);

    await Promise.all(fileUploadPromises).catch(() => {});

    // Phase 2: retry failed files sequentially with delays
    // By this point, the SafeLine iframe auto-resolver has had time
    // to fix any session issues.  Retrying sequentially prevents
    // overwhelming a just-recovered backend.
    for (let i = 0; i < retryQueue.length; i++) {
      if (abortCtrl.signal.aborted) break;
      const { file, fileIndex } = retryQueue[i];

      const attempt = fileAttempts.get(fileIndex) ?? 1;
      const delay = FILE_RETRY_DELAYS[attempt - 1] ?? 120_000;

      console.warn(
        `[UPLOAD] "${file.name}" retry ${attempt}/${MAX_FILE_RETRIES}, waiting ${delay / 1000}s...`,
      );
      showNotification({
        id: `file-retry-${fileIndex}`,
        title: t("upload.notify.fileRetry.title", {
          defaultMessage: "Retry fichier",
        }),
        message: t("upload.notify.fileRetry.message", {
          defaultMessage: `${file.name} - tentative ${attempt + 1}/${MAX_FILE_RETRIES + 1} dans ${delay / 1000}s`,
          name: file.name,
          delay: delay / 1000,
          attempt: attempt + 1,
          max: MAX_FILE_RETRIES + 1,
        }),
        color: "yellow",
        autoClose: delay,
      });
      await new Promise((r) => setTimeout(r, delay));
      if (abortCtrl.signal.aborted) break;

      const result = await uploadSingleFile(file, fileIndex);
      if (result === "retryable") {
        // Push back for another round if we haven't exceeded max
        const nextAttempt = fileAttempts.get(fileIndex) ?? 2;
        if (nextAttempt <= MAX_FILE_RETRIES) {
          retryQueue.push({ file, fileIndex });
        } else {
          toast.error(
            `${file.name}: échec définitif après ${nextAttempt} tentatives`,
          );
          setFiles((prev) =>
            prev.map((f, idx) => {
              if (idx === fileIndex) f.uploadingProgress = -1;
              return f;
            }),
          );
        }
      }
    }

    // Cleanup: stop keepalive, mark upload as inactive.
    // The useEffect watching file progress handles completion (all 100%)
    // or failure (some -1) states and triggers the appropriate UI.
    if (keepaliveRef.current) {
      clearInterval(keepaliveRef.current);
      keepaliveRef.current = null;
    }
    setUploadActive(false);
  };

  const cancelUpload = () => {
    modals.openConfirmModal({
      title: t("upload.cancel.title", { defaultMessage: "Annuler l'envoi" }),
      children: (
        <Text size="sm">
          <FormattedMessage
            id="upload.cancel.confirm"
            defaultMessage="L'envoi en cours sera interrompu et le partage incomplet supprimé. Continuer ?"
          />
        </Text>
      ),
      labels: {
        confirm: t("common.button.confirm", { defaultMessage: "Confirmer" }),
        cancel: t("common.button.cancel", { defaultMessage: "Non" }),
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
        toast.success(t("upload.cancel.done", { defaultMessage: "Envoi annulé" }));
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
        // Show the "share E2E key via email" checkbox only when the user
        // already has an E2E key set up (server hash recorded or key in RAM).
        userHasE2E: !!user?.hasEncryptionKey || !!getUserKey(),
        maxExpiration: config.get("share.maxExpiration"),
        anonymousMaxExpiration: config.get("share.anonymousMaxExpiration"),
        configuredMaxExpirationDays: configuredMaxExpirationDays?.maxDays ?? 0,
        shareIdLength: config.get("share.shareIdLength"),
        simplified,
        captchaEnabled: !user && config.get("altcha.enabled"),
        preselectedTeamFolderId: qTeamFolderId,
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

  const handleWebDavFilesImported = (importedFiles: FileUpload[]) => {
    setFiles((currentFiles) => [...currentFiles, ...importedFiles]);
  };

  useEffect(() => {
    // Check if there are any files that failed to upload
    const fileErrorCount = files.filter(
      (file) => file.uploadingProgress == -1,
    ).length;

    if (fileErrorCount > 0) {
      if (!errorToastShown) {
        toast.info(
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
    // Also delete the incomplete share to clean up any S3 objects that were
    // already committed for the files that did succeed (partial multi-file
    // upload failure). Without this, those S3 objects are orphaned until the
    // deleteUnfinishedShares cron runs (up to 30 h later).
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
      // Best-effort cleanup: delete the incomplete share (S3 prefix purge +
      // DB record). Ignore errors - the cron will catch any leftovers.
      if (createdShare?.id) {
        shareService.remove(createdShare.id).catch(() => {});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  return (
    <>
      <Meta title={t("upload.title")} noIndex />
      <Title order={1} visually-hidden style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap" }}>
        {t("upload.title")}
      </Title>
      {showBrowserSetup && (
        <Alert
          variant="light"
          color="blue"
          mb="sm"
          icon={<TbInfoCircle size={18} />}
          title={t("upload.browser-setup.title")}
          withCloseButton
          closeButtonLabel={t("upload.browser-setup.dismiss")}
          onClose={handleDismissBanner}
        >
          <Stack gap="sm">
            {!popupsAllowed && (
              <>
                <Text size="sm">
                  <FormattedMessage id="upload.browser-setup.popup-body" />
                </Text>
                <Group>
                  <Button
                    size="compact-sm"
                    variant="light"
                    color="yellow"
                    onClick={handleTestPopup}
                  >
                    <FormattedMessage id="upload.browser-setup.popup-button" />
                  </Button>
                </Group>
              </>
            )}
            {showNotifPrompt && (
              <>
                <Text size="sm">
                  <FormattedMessage id="upload.browser-setup.notif-body" />
                </Text>
                <Group>
                  <Button
                    size="compact-sm"
                    variant="light"
                    onClick={handleRequestNotifPermission}
                  >
                    <FormattedMessage id="upload.browser-setup.notif-button" />
                  </Button>
                </Group>
              </>
            )}
          </Stack>
        </Alert>
      )}
      {qTeamFolderId && (
        <Alert
          variant="light"
          color="teal"
          mb="sm"
          icon={<TbFolder size={18} />}
          title={t("upload.team-folder.hint.title")}
        >
          {targetFolderInfo
            ? t("upload.team-folder.hint", { folderName: targetFolderInfo.folder.name, teamName: targetFolderInfo.teamName })
            : t("upload.team-folder.hint.unknown")}
        </Alert>
      )}
      <Group
        justify={name ? "space-between" : "flex-end"}
        mb={20}
      >
        {name && <Title order={3}>{name}</Title>}
        <Group gap="xs">
          {canUseWebDav && (
            <Button
              variant="light"
              leftSection={<TbCloudDownload size={16} />}
              disabled={isUploading}
              onClick={() => setWebDavOpened(true)}
            >
              <FormattedMessage id="webdav.button.import" />
            </Button>
          )}
          <Button
            loading={isUploading}
            disabled={files.length <= 0}
            onClick={() => showCreateUploadModalCallback(files)}
          >
            <FormattedMessage id="common.button.share" />
          </Button>
        </Group>
      </Group>
      <WebDavImportModal
        opened={webDavOpened}
        onClose={() => setWebDavOpened(false)}
        onFilesImported={handleWebDavFilesImported}
        maxShareSize={effectiveMaxShareSize}
        existingFilesSize={files.reduce((sum, f) => sum + f.size, 0)}
      />
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
      {/* Quota Gauge - visible after files are added, before sharing */}
      {files.length > 0 && !isUploading && (() => {
        const totalFilesSize = files.reduce((sum, f) => sum + f.size, 0);
        const quotaUsedPct = effectiveMaxShareSize > 0
          ? Math.min(Math.round((totalFilesSize / effectiveMaxShareSize) * 100), 100)
          : 0;
        const isOverQuota = totalFilesSize > effectiveMaxShareSize;
        const formatSize = (bytes: number) => {
          if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
          if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
          if (bytes >= 1000) return `${(bytes / 1000).toFixed(0)} KB`;
          return `${bytes} B`;
        };
        return (
          <Stack gap={4} mt="sm" mb="xs">
            <Group justify="space-between" align="center">
              <Group gap="xs">
                <TbCloudUpload size={16} />
                <Text size="sm" fw={500}>
                  <FormattedMessage id="upload.quota.label" defaultMessage="Quota d'envoi" />
                </Text>
              </Group>
              <Text size="sm" c={isOverQuota ? "red" : "dimmed"} fw={isOverQuota ? 600 : 400}>
                {formatSize(totalFilesSize)} / {formatSize(effectiveMaxShareSize)}
              </Text>
            </Group>
            <Progress
              value={quotaUsedPct}
              size="md"
              radius="xl"
              color={isOverQuota ? "red" : quotaUsedPct > 80 ? "yellow" : "blue"}
            />
            {isOverQuota && (
              <Text size="xs" c="red" ta="center">
                <FormattedMessage
                  id="upload.quota.exceeded"
                  defaultMessage="La taille totale des fichiers dépasse la limite configurée. Retirez des fichiers ou demandez à l'administrateur de l'instance de l'augmenter."
                />
              </Text>
            )}
          </Stack>
        );
      })()}
      {isUploading && files.length > 0 && (() => {
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        const uploadedSize = files.reduce((sum, f) => {
          const pct = Math.max(0, f.uploadingProgress ?? 0);
          return sum + (f.size * Math.min(pct, 100)) / 100;
        }, 0);
        const globalPct = totalSize > 0 ? Math.min(Math.round((uploadedSize / totalSize) * 100), 100) : 0;
        const done = files.filter((f) => f.uploadingProgress >= 100).length;
        const failed = files.filter((f) => f.uploadingProgress === -1).length;
        const fmtSz = (b: number) => {
          if (b >= 1_000_000_000) return `${(b / 1_000_000_000).toFixed(2)} GB`;
          if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
          if (b >= 1000) return `${(b / 1000).toFixed(0)} KB`;
          return `${b} B`;
        };
        const sizeLabel = `${fmtSz(uploadedSize)} / ${fmtSz(totalSize)}`;
        return (
          <Stack gap={4} mt="sm" mb="xs">
            <Group justify="space-between">
              <Text size="sm" fw={500}>
                <FormattedMessage
                  id="upload.progress.global"
                  defaultMessage="Upload: {done}/{total} files"
                  values={{ done: done + failed, total: files.length }}
                />
              </Text>
              <Group gap="xs">
                <Text size="sm" c="dimmed">{globalPct}%</Text>
                <Button
                  size="compact-sm"
                  color="red"
                  variant="subtle"
                  onClick={cancelUpload}
                >
                  <FormattedMessage
                    id="upload.cancel.button"
                    defaultMessage="Annuler"
                  />
                </Button>
              </Group>
            </Group>
            {/* Progress bar with contrast-inverted size label */}
            <div style={{ position: "relative", width: "100%", height: 10, borderRadius: 10, overflow: "hidden" }}>
              <Progress.Root size={10} style={{ position: "absolute", inset: 0 }}>
                <Progress.Section
                  value={globalPct}
                  animated={globalPct < 100}
                  color={globalPct >= 100 ? "green" : "yellow"}
                />
              </Progress.Root>
              {/* White text on unfilled background */}
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#fff",
                  pointerEvents: "none",
                  whiteSpace: "nowrap",
                }}
              >
                {sizeLabel}
              </span>
              {/* Dark text clipped to filled area */}
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#1a1b1e",
                  pointerEvents: "none",
                  whiteSpace: "nowrap",
                  clipPath: `inset(0 ${100 - globalPct}% 0 0)`,
                  transition: "clip-path 0.4s ease",
                }}
              >
                {sizeLabel}
              </span>
            </div>
          </Stack>
        );
      })()}
      {files.length > 0 && (
        <FileList<FileUpload> files={files} setFiles={setFiles} isUploading={isUploading} />
      )}
    </>
  );
};
export default Upload;
