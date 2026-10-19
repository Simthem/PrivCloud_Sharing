import { isLocalOrPrivateWebDavTarget } from "../../services/webdav.service";
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  PasswordInput,
  Progress,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import {
  TbArrowBackUp,
  TbCloudDownload,
  TbFolder,
  TbFile,
  TbLink,
  TbPlugOff,
  TbRefresh,
  TbSelectAll,
} from "react-icons/tb";
import useTranslate from "../../hooks/useTranslate.hook";
import { WebDavCredentials, WebDavEntry } from "../../services/webdav.service";
import {
  authorizeBridge,
  BridgeHealth,
  downloadWebDavFileViaBridge,
  forgetBridgeToken,
  getBridgeHealth,
  hasBridgeToken,
  isOpenSourceBridgeCompatible,
  listWebDavDirectoryViaBridge,
} from "../../services/privcloudBridge.service";
import { BridgeWebDavSource, FileUpload } from "../../types/File.type";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import toast from "../../utils/toast.util";
import { attachUploadRelativePath } from "../../utils/uploadPath.util";
import { collectWebDavFiles } from "../../utils/webDavTree.util";

const LARGE_IMPORT_WARNING_BYTES = 2_000_000_000;
const MAX_SELECTED_FILES = 20;
const WEBDAV_SESSION_STORAGE_KEY = "privcloud_webdav_session";
const WEBDAV_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

type StoredWebDavSession = {
  endpoint: string;
  username: string;
  password: string;
  currentUrl: string;
  history: string[];
  savedAt: number;
};

type Props = {
  opened: boolean;
  onClose: () => void;
  onFilesImported: (_files: FileUpload[]) => void;
  maxShareSize: number;
  existingFilesSize: number;
};

function errorToMessage(error: unknown, t: ReturnType<typeof useTranslate>) {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("webdav.") || message.startsWith("bridge.")) {
    return t(message);
  }
  if (message.includes("Too many active Bridge jobs")) {
    return t("bridge.error.tooManyJobs");
  }
  if (
    message.includes("Private or reserved WebDAV addresses are not allowed")
  ) {
    return t("bridge.error.companionUpdateRequiredVpn");
  }
  if (error instanceof TypeError) return t("bridge.error.localNetworkBlocked");
  return message || t("webdav.error.generic");
}

function asUploadFile(file: File): FileUpload {
  return Object.assign(file, { uploadingProgress: 0 }) as FileUpload;
}

function sortWebDavEntries(entries: WebDavEntry[]): WebDavEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function readStoredWebDavSession(): StoredWebDavSession | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(WEBDAV_SESSION_STORAGE_KEY);
    if (!raw) return null;

    const session = JSON.parse(raw) as Partial<StoredWebDavSession>;
    if (
      typeof session.savedAt !== "number" ||
      Date.now() - session.savedAt > WEBDAV_SESSION_TTL_MS
    ) {
      window.sessionStorage.removeItem(WEBDAV_SESSION_STORAGE_KEY);
      return null;
    }

    return {
      endpoint: typeof session.endpoint === "string" ? session.endpoint : "",
      username: typeof session.username === "string" ? session.username : "",
      password: typeof session.password === "string" ? session.password : "",
      currentUrl:
        typeof session.currentUrl === "string" ? session.currentUrl : "",
      history: Array.isArray(session.history)
        ? (session.history as string[]).filter((h) => typeof h === "string")
        : [],
      savedAt: session.savedAt,
    };
  } catch {
    window.sessionStorage.removeItem(WEBDAV_SESSION_STORAGE_KEY);
    return null;
  }
}

function writeStoredWebDavSession(
  session: Omit<StoredWebDavSession, "savedAt">,
) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      WEBDAV_SESSION_STORAGE_KEY,
      JSON.stringify({ ...session, savedAt: Date.now() }),
    );
  } catch {
    // Session persistence is a comfort feature; WebDAV import still works without it.
  }
}

function clearStoredWebDavSession() {
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem(WEBDAV_SESSION_STORAGE_KEY);
    } catch {
      // Ignore unavailable storage.
    }
  }
}

function asBridgeWebDavUploadFile(
  credentials: WebDavCredentials,
  entry: WebDavEntry,
): FileUpload {
  const source: BridgeWebDavSource = {
    endpoint: credentials.endpoint,
    username: credentials.username,
    password: credentials.password,
    href: entry.href,
    contentType: entry.contentType,
    lastModified: entry.lastModified,
  };

  return {
    name: entry.name,
    size: entry.size,
    type: entry.contentType || "application/octet-stream",
    lastModified: entry.lastModified
      ? Date.parse(entry.lastModified)
      : Date.now(),
    uploadingProgress: 0,
    privcloudBridgeSource: source,
  } as FileUpload;
}

const WebDavImportModal = ({
  opened,
  onClose,
  onFilesImported,
  maxShareSize,
  existingFilesSize,
}: Props) => {
  const t = useTranslate();
  const [endpoint, setEndpoint] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [entries, setEntries] = useState<WebDavEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [importProgress, setImportProgress] = useState(0);
  const [enumeratedFiles, setEnumeratedFiles] = useState<number | null>(null);
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);
  const [useBridge, setUseBridge] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [bridgeProbeComplete, setBridgeProbeComplete] = useState(false);
  const [sessionRestored, setSessionRestored] = useState(false);

  // Prevents auto-load from firing more than once per modal opening
  const autoLoadFiredRef = useRef(false);
  const importControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => importControllerRef.current?.abort(), []);

  const credentials: WebDavCredentials = useMemo(
    () => ({ endpoint, username, password }),
    [endpoint, username, password],
  );

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedIds.has(entry.id)),
    [entries, selectedIds],
  );
  const selectableEntries = useMemo(() => entries, [entries]);
  const selectedVisibleEntryCount = selectableEntries.filter((entry) =>
    selectedIds.has(entry.id),
  ).length;
  const allVisibleEntriesSelected =
    selectableEntries.length > 0 &&
    selectedVisibleEntryCount === selectableEntries.length;
  const someVisibleEntriesSelected =
    selectedVisibleEntryCount > 0 && !allVisibleEntriesSelected;
  const selectedSize = selectedEntries.reduce(
    (sum, entry) => sum + entry.size,
    0,
  );
  const bridgeTokenConfigured = useBridge && hasBridgeToken();
  const bridgeEnabled =
    bridgeTokenConfigured && isOpenSourceBridgeCompatible(bridgeHealth);
  const bridgeManagedImport =
    bridgeEnabled && !!bridgeHealth?.capabilities.managedEncryptedUpload;
  const sizeLimitExceeded =
    maxShareSize < Number.MAX_SAFE_INTEGER &&
    existingFilesSize + selectedSize > maxShareSize;
  const manyDirectFiles =
    !bridgeManagedImport && selectedEntries.length > MAX_SELECTED_FILES;
  const selectedHasLargeFiles = selectedEntries.some(
    (entry) => !bridgeManagedImport && entry.size > LARGE_IMPORT_WARNING_BYTES,
  );
  const canImport =
    selectedEntries.length > 0 && !sizeLimitExceeded && !importing;

  const resetSession = () => {
    setEntries([]);
    setSelectedIds(new Set());
    setCurrentUrl("");
    setHistory([]);
    setError("");
    setImportProgress(0);
  };

  useEffect(() => {
    if (sessionRestored) return;
    const storedSession = readStoredWebDavSession();
    if (storedSession) {
      setEndpoint(storedSession.endpoint);
      setUsername(storedSession.username);
      setPassword(storedSession.password);
      setCurrentUrl(storedSession.currentUrl);
      setHistory(storedSession.history);
    }
    setSessionRestored(true);
  }, [sessionRestored]);

  useEffect(() => {
    if (!sessionRestored) return;
    if (!endpoint && !username && !password && !currentUrl) {
      clearStoredWebDavSession();
      return;
    }
    writeStoredWebDavSession({
      endpoint,
      username,
      password,
      currentUrl,
      history,
    });
  }, [endpoint, username, password, currentUrl, history, sessionRestored]);

  // Reset the auto-load flag every time the modal closes.
  useEffect(() => {
    if (!opened) autoLoadFiredRef.current = false;
  }, [opened]);

  // Reuse an existing Companion pairing without probing localhost on modal open.
  useEffect(() => {
    if (!opened) return;
    setUseBridge(hasBridgeToken());
  }, [opened]);

  // Refresh the directory when the modal opens if a session is already active
  // (endpoint + currentUrl), including the first opening after session restore.
  useEffect(() => {
    if (
      !opened ||
      !sessionRestored ||
      !currentUrl ||
      !endpoint ||
      !username ||
      !password ||
      autoLoadFiredRef.current
    )
      return;
    autoLoadFiredRef.current = true;
    loadDirectory(currentUrl);
    // loadDirectory changes on every render; it is intentionally excluded so the
    // effect only runs on the state transitions listed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, sessionRestored, currentUrl, endpoint, username, password]);

  const handleClose = () => {
    if (importing) return;
    onClose();
  };

  const handleDisconnect = () => {
    if (importing) return;
    resetSession();
    setEndpoint("");
    setUsername("");
    setPassword("");
    clearStoredWebDavSession();
    toast.success(t("webdav.toast.disconnected"));
  };

  const handleStartPairing = async () => {
    setPairingBusy(true);
    setError("");
    try {
      const health = await getBridgeHealth({ requestLocalAccess: true });
      setBridgeHealth(health);
      if (!health?.capabilities.webdav) {
        throw new Error("bridge.status.unavailable");
      }
      if (!isOpenSourceBridgeCompatible(health)) {
        forgetBridgeToken();
        setUseBridge(false);
        throw new Error("bridge.error.openSourceUpdateRequired");
      }
      await authorizeBridge();
      setUseBridge(true);
      setBridgeHealth(await getBridgeHealth());
      toast.success(t("bridge.toast.paired"));
    } catch (e) {
      setError(errorToMessage(e, t));
    } finally {
      setBridgeProbeComplete(true);
      setPairingBusy(false);
    }
  };

  const loadDirectory = async (url?: string, pushHistory = false) => {
    setLoading(true);
    setError("");
    try {
      let result;
      let bridgeError: unknown;
      if (useBridge && hasBridgeToken()) {
        const health = await getBridgeHealth();
        setBridgeHealth(health);
        setBridgeProbeComplete(true);

        if (health && !isOpenSourceBridgeCompatible(health)) {
          forgetBridgeToken();
          setUseBridge(false);
          throw new Error("bridge.error.openSourceUpdateRequired");
        } else if (health) {
          try {
            result = await listWebDavDirectoryViaBridge(credentials, url);
          } catch (e) {
            bridgeError = e;
          }
        }
      }

      if (!result) {
        throw bridgeError || new Error("bridge.error.localNetworkRequired");
      }
      if (!url) {
        setHistory([]);
      }
      if (pushHistory && currentUrl) {
        setHistory((prev) => [...prev, currentUrl]);
      }
      setCurrentUrl(result!.url);
      setEntries(sortWebDavEntries(result!.entries));
      setSelectedIds(new Set());
    } catch (e) {
      setError(errorToMessage(e, t));
    } finally {
      setLoading(false);
    }
  };

  const goBack = async () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((prev) => prev.slice(0, -1));
    await loadDirectory(previous);
  };

  const toggleEntry = (entry: WebDavEntry) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entry.id)) next.delete(entry.id);
      else next.add(entry.id);
      return next;
    });
  };

  const toggleVisibleFiles = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleEntriesSelected) {
        selectableEntries.forEach((entry) => next.delete(entry.id));
      } else {
        selectableEntries.forEach((entry) => next.add(entry.id));
      }
      return next;
    });
  };

  const handleEntryClick = (entry: WebDavEntry) => {
    if (loading || importing) return;
    if (entry.isDirectory) {
      loadDirectory(entry.href, true);
      return;
    }
    toggleEntry(entry);
  };

  const handleImport = async () => {
    if (!canImport) return;
    setImporting(true);
    setError("");
    setImportProgress(0);
    setEnumeratedFiles(0);
    const controller = new AbortController();
    importControllerRef.current = controller;
    const imported: FileUpload[] = [];

    try {
      const selectedFiles = await collectWebDavFiles({
        currentUrl,
        selected: selectedEntries,
        maxBytes: Math.max(0, maxShareSize - existingFilesSize),
        maxFiles: bridgeManagedImport
          ? bridgeHealth?.jobs?.maxFilesPerJob
          : undefined,
        signal: controller.signal,
        onProgress: (files) => setEnumeratedFiles(files),
        listDirectory: (url, signal) =>
          listWebDavDirectoryViaBridge(credentials, url, signal),
      });
      setEnumeratedFiles(null);
      if (bridgeManagedImport) {
        if (
          selectedFiles.some((file) => !!file.uploadRelativePath) &&
          !bridgeHealth?.capabilities.relativePathsV1
        )
          throw new Error("webdav.error.companionFolderUpdateRequired");
        imported.push(
          ...selectedFiles.map((entry) =>
            attachUploadRelativePath(
              asBridgeWebDavUploadFile(credentials, entry),
              entry.uploadRelativePath,
            ),
          ),
        );
        setImportProgress(100);
      } else {
        for (let i = 0; i < selectedFiles.length; i++) {
          controller.signal.throwIfAborted();
          const entry = selectedFiles[i];
          let file: File | undefined;
          let bridgeError: unknown;
          const requiresBridge = isLocalOrPrivateWebDavTarget(
            entry.href || credentials.endpoint,
          );
          const bridgeTokenAvailable = hasBridgeToken();
          if (!bridgeTokenAvailable) {
            throw new Error("bridge.error.companionRequired");
          }
          try {
            file = await downloadWebDavFileViaBridge(
              credentials,
              entry,
              controller.signal,
            );
          } catch (e) {
            bridgeError = e;
          }
          if (!file) {
            if (requiresBridge) {
              throw (
                bridgeError || new Error("bridge.error.localNetworkRequired")
              );
            }
            throw bridgeError || new Error("bridge.error.companionRequired");
          }
          imported.push(
            attachUploadRelativePath(
              asUploadFile(file),
              entry.uploadRelativePath,
            ),
          );
          controller.signal.throwIfAborted();
          if (
            existingFilesSize +
              imported.reduce((sum, file) => sum + file.size, 0) >
            maxShareSize
          ) {
            throw new Error("webdav.error.quota");
          }
          setImportProgress(Math.round(((i + 1) / selectedFiles.length) * 100));
        }
      }

      controller.signal.throwIfAborted();
      if (
        existingFilesSize + imported.reduce((sum, file) => sum + file.size, 0) >
        maxShareSize
      ) {
        throw new Error("webdav.error.quota");
      }
      onFilesImported(imported);
      toast.success(t("webdav.toast.imported", { count: imported.length }));
      setSelectedIds(new Set());
      setImportProgress(0);
    } catch (e) {
      setError(
        controller.signal.aborted
          ? t("webdav.error.cancelled")
          : errorToMessage(e, t),
      );
    } finally {
      importControllerRef.current = null;
      setEnumeratedFiles(null);
      setImporting(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      size="xl"
      title={
        <Group gap="xs">
          <TbCloudDownload size={18} />
          <Text fw={600}>
            <FormattedMessage id="webdav.modal.title" />
          </Text>
        </Group>
      }
    >
      <Stack gap="md">
        {bridgeEnabled ? (
          <Alert color={useBridge ? "teal" : "blue"} variant="light">
            <Group justify="space-between" align="center" gap="xs">
              <Group gap="xs">
                <TbLink size={18} />
                <Text size="sm">
                  <FormattedMessage
                    id={
                      bridgeHealth
                        ? "bridge.status.ready"
                        : "bridge.status.enabled"
                    }
                    values={{ version: bridgeHealth?.version }}
                  />
                </Text>
              </Group>
            </Group>
          </Alert>
        ) : (
          <Alert color="blue" variant="light">
            <Group justify="space-between" align="center" gap="xs">
              <Group gap="xs">
                <TbLink size={18} />
                <Text size="sm">
                  <FormattedMessage
                    id={
                      bridgeHealth &&
                      !isOpenSourceBridgeCompatible(bridgeHealth)
                        ? "bridge.error.openSourceUpdateRequired"
                        : bridgeHealth
                          ? "bridge.status.detected"
                          : bridgeProbeComplete && bridgeTokenConfigured
                            ? "bridge.status.unavailable"
                            : bridgeTokenConfigured
                              ? "bridge.status.saved"
                              : "bridge.status.proxyDefault"
                    }
                    values={{ version: bridgeHealth?.version }}
                  />
                </Text>
              </Group>
              <Button
                size="compact-sm"
                variant="light"
                loading={pairingBusy}
                onClick={handleStartPairing}
              >
                <FormattedMessage id="bridge.pair.start" />
              </Button>
            </Group>
          </Alert>
        )}

        {!currentUrl && (
          <>
            <Group grow align="flex-end">
              <TextInput
                label={t("webdav.endpoint.label")}
                placeholder="https://cloud.example/remote.php/dav/files/alice/"
                value={endpoint}
                onChange={(event) => setEndpoint(event.currentTarget.value)}
                disabled={loading || importing}
              />
              <TextInput
                label={t("webdav.username.label")}
                value={username}
                onChange={(event) => setUsername(event.currentTarget.value)}
                disabled={loading || importing}
              />
            </Group>
            <Group grow align="flex-end">
              <PasswordInput
                label={t("webdav.password.label")}
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                disabled={loading || importing}
              />
              <Button
                leftSection={<TbCloudDownload size={16} />}
                loading={loading}
                disabled={!endpoint || !username || !password || importing}
                onClick={() => loadDirectory()}
              >
                <FormattedMessage id="webdav.connect" />
              </Button>
            </Group>
          </>
        )}

        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        {currentUrl && (
          <Stack gap={6}>
            {/* Row 1: back, refresh, and URL stay on one line. */}
            <Group gap="xs" wrap="nowrap">
              <Tooltip label={t("webdav.back")}>
                <ActionIcon
                  variant="light"
                  size="lg"
                  onClick={goBack}
                  disabled={history.length === 0 || loading || importing}
                  aria-label={t("webdav.back")}
                >
                  <TbArrowBackUp size={16} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={t("webdav.refresh")}>
                <ActionIcon
                  variant="light"
                  size="lg"
                  onClick={() => loadDirectory(currentUrl)}
                  disabled={loading || importing}
                  aria-label={t("webdav.refresh")}
                >
                  <TbRefresh size={16} />
                </ActionIcon>
              </Tooltip>
              <Text
                size="xs"
                c="dimmed"
                lineClamp={1}
                style={{ flex: 1, minWidth: 0 }}
              >
                {currentUrl}
              </Text>
            </Group>
            {/* Row 2: selection controls, disconnect, and selected size. */}
            <Group justify="flex-end" gap="xs" wrap="nowrap">
              {selectableEntries.length > 0 && (
                <Button
                  size="compact-sm"
                  variant="light"
                  leftSection={<TbSelectAll size={16} />}
                  onClick={toggleVisibleFiles}
                  disabled={importing}
                >
                  <FormattedMessage
                    id={
                      allVisibleEntriesSelected
                        ? "webdav.clearSelection"
                        : "webdav.selectAll"
                    }
                  />
                </Button>
              )}
              <Button
                size="compact-sm"
                variant="subtle"
                color="red"
                leftSection={<TbPlugOff size={16} />}
                onClick={handleDisconnect}
                disabled={importing}
              >
                <FormattedMessage id="webdav.disconnect" />
              </Button>
              <Text size="xs" c={sizeLimitExceeded ? "red" : "dimmed"}>
                {byteToHumanSizeString(selectedSize)}
              </Text>
            </Group>
          </Stack>
        )}

        {entries.length > 0 && (
          <Text size="xs" c="dimmed">
            <FormattedMessage id="webdav.folderHint" />
          </Text>
        )}

        {entries.length > 0 && (
          <ScrollArea h={420} offsetScrollbars>
            <Table stickyHeader verticalSpacing="sm">
              <thead>
                <tr>
                  <th style={{ width: 58 }}>
                    <Checkbox
                      size="md"
                      checked={allVisibleEntriesSelected}
                      indeterminate={someVisibleEntriesSelected}
                      disabled={selectableEntries.length === 0 || importing}
                      onChange={toggleVisibleFiles}
                      aria-label={t("webdav.selectAll")}
                    />
                  </th>
                  <th>
                    <FormattedMessage id="upload.filelist.name" />
                  </th>
                  <th
                    style={{ width: 92, textAlign: "right", paddingRight: 8 }}
                  >
                    <FormattedMessage id="upload.filelist.size" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  return (
                    <tr
                      key={entry.id}
                      onClick={() => handleEntryClick(entry)}
                      style={{
                        cursor: "pointer",
                        height: 56,
                      }}
                    >
                      <td>
                        <Checkbox
                          size="md"
                          checked={selectedIds.has(entry.id)}
                          disabled={importing}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleEntry(entry)}
                          aria-label={entry.name}
                        />
                      </td>
                      <td>
                        <Group gap="xs" wrap="nowrap">
                          {entry.isDirectory ? (
                            <TbFolder size={18} />
                          ) : (
                            <TbFile size={18} />
                          )}
                          <Text
                            size="sm"
                            fw={entry.isDirectory ? 500 : 400}
                            lineClamp={1}
                          >
                            {entry.name}
                          </Text>
                        </Group>
                      </td>
                      <td
                        style={{
                          width: 92,
                          textAlign: "right",
                          paddingRight: 8,
                        }}
                      >
                        <Text
                          size="sm"
                          c="dimmed"
                          ta="right"
                          style={{ whiteSpace: "nowrap" }}
                        >
                          {entry.isDirectory
                            ? "-"
                            : byteToHumanSizeString(entry.size)}
                        </Text>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </ScrollArea>
        )}

        {(sizeLimitExceeded || manyDirectFiles || selectedHasLargeFiles) && (
          <Alert color="yellow" variant="light">
            {sizeLimitExceeded && (
              <Text size="sm">{t("webdav.warning.quota")}</Text>
            )}
            {manyDirectFiles && (
              <Text size="sm">{t("webdav.warning.maxFiles")}</Text>
            )}
            {selectedHasLargeFiles && (
              <Text size="sm">
                {t("webdav.warning.largeFiles", {
                  max: byteToHumanSizeString(LARGE_IMPORT_WARNING_BYTES),
                })}
              </Text>
            )}
          </Alert>
        )}

        {importing && (
          <Stack gap="xs">
            {enumeratedFiles !== null && (
              <Text size="sm" role="status">
                <FormattedMessage
                  id="webdav.enumerating"
                  values={{ count: enumeratedFiles }}
                />
              </Text>
            )}
            <Progress value={importProgress} animated />
          </Stack>
        )}

        <Group
          justify="space-between"
          style={
            currentUrl
              ? {
                  position: "sticky",
                  bottom: 0,
                  backgroundColor: "var(--mantine-color-body)",
                  paddingTop: 8,
                  zIndex: 1,
                }
              : undefined
          }
        >
          <Text size="xs" c="dimmed">
            <FormattedMessage
              id={
                bridgeEnabled
                  ? "webdav.footer.zeroPersistence.bridge"
                  : "webdav.footer.zeroPersistence"
              }
            />
          </Text>
          <Group>
            <Button
              variant="subtle"
              onClick={() =>
                importing ? importControllerRef.current?.abort() : handleClose()
              }
            >
              <FormattedMessage id="common.button.cancel" />
            </Button>
            <Button
              leftSection={<TbCloudDownload size={16} />}
              onClick={handleImport}
              disabled={!canImport}
              loading={importing}
            >
              <FormattedMessage id="webdav.import" />
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
};

export default WebDavImportModal;
