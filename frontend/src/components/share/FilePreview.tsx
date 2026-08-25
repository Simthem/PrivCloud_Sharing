import {
  Button,
  Center,
  Loader,
  ScrollArea,
  Stack,
  Text,
  Title,
  useMantineColorScheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import type { MarkdownToJSX } from "markdown-to-jsx";
import dynamic from "next/dynamic";
import Link from "next/link";

const Markdown = dynamic(() => import("markdown-to-jsx"), { ssr: false });
import React, { Dispatch, SetStateAction, useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import api from "../../services/api.service";
import {
  fetchDecryptedFile,
  fetchDecryptedFilePrefix,
} from "../../services/share.service";
import {
  isPreviewMimeTypeSupported,
  isTextBasedMimeType,
  sniffPreviewMimeType,
} from "../../utils/filePreview.util";

export { isTextBasedMimeType } from "../../utils/filePreview.util";

// ── Security helpers for text previews ──────────────────────────────

/** Maximum characters of text content to render in preview (1 MiB). */
const MAX_TEXT_PREVIEW_CHARS = 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = MAX_TEXT_PREVIEW_CHARS;
const MIME_SNIFF_BYTES = 64 * 1024;

const fetchPreviewPrefix = async (
  shareId: string,
  fileId: string,
  e2eKey: string | null | undefined,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> => {
  if (e2eKey) {
    return fetchDecryptedFilePrefix(shareId, fileId, e2eKey, maxBytes, signal);
  }

  const response = await api.get(
    `/shares/${shareId}/files/${fileId}?download=false`,
    {
      responseType: "arraybuffer",
      headers: { Range: `bytes=0-${maxBytes - 1}` },
      signal,
    },
  );
  return response.data as ArrayBuffer;
};

/** Truncate a string if it exceeds the safe preview limit. */
const truncateForPreview = (s: string): string =>
  s.length > MAX_TEXT_PREVIEW_CHARS
    ? s.slice(0, MAX_TEXT_PREVIEW_CHARS) +
      "\n\n[… truncated — file too large for preview]"
    : s;

const ensureString = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

/**
 * Normalise vendor video MIME types to standard ones so the browser
 * recognises them in Blob and &lt;source type&gt;.
 * e.g. video/x-m4v -> video/mp4  (M4V is just an MP4 container)
 */
const normalizeVideoMime = (m: string): string => {
  if (m === "video/x-m4v" || m === "video/x-mp4") return "video/mp4";
  if (m === "video/x-matroska") return "video/webm";
  return m;
};

const FilePreviewContext = React.createContext<{
  shareId: string;
  fileId: string;
  mimeType: string;
  fileSizeBytes?: number;
  e2eKey?: string | null;
  setMimeType: Dispatch<SetStateAction<string>>;
  setIsNotSupported: Dispatch<SetStateAction<boolean>>;
}>({
  shareId: "",
  fileId: "",
  mimeType: "",
  fileSizeBytes: undefined,
  e2eKey: null,
  setMimeType: () => {},
  setIsNotSupported: () => {},
});

/** Hook: fetch encrypted file, decrypt, return a blob URL */
const useDecryptedBlobUrl = (mimeType: string) => {
  const { shareId, fileId, e2eKey, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!e2eKey) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    let revoke: string | null = null;
    fetchDecryptedFile(shareId, fileId, e2eKey, controller.signal)
      .then((decrypted) => {
        if (!active) return;
        const blob = new Blob([decrypted], { type: mimeType });
        const url = URL.createObjectURL(blob);
        revoke = url;
        setBlobUrl(url);
      })
      .catch(() => {
        if (active && !controller.signal.aborted) setIsNotSupported(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [shareId, fileId, e2eKey, mimeType, setIsNotSupported]);

  return { blobUrl, loading };
};

const FilePreview = ({
  shareId,
  fileId,
  mimeType,
  fileSizeBytes,
  e2eKey,
}: {
  shareId: string;
  fileId: string;
  mimeType: string;
  fileSizeBytes?: number;
  e2eKey?: string | null;
}) => {
  const [isNotSupported, setIsNotSupported] = useState(false);
  const [resolvedMimeType, setResolvedMimeType] = useState(mimeType);

  useEffect(() => setResolvedMimeType(mimeType), [mimeType]);

  if (isNotSupported) return <UnSupportedFile />;

  return (
    <Stack>
      <FilePreviewContext.Provider
        value={{
          shareId,
          fileId,
          mimeType: resolvedMimeType,
          fileSizeBytes,
          e2eKey,
          setMimeType: setResolvedMimeType,
          setIsNotSupported,
        }}
      >
        {resolvedMimeType ? <FileDecider /> : <FileTypeDetector />}
      </FilePreviewContext.Provider>
      {!e2eKey && (
        <Button
          variant="subtle"
          component={Link}
          onClick={() => modals.closeAll()}
          target="_blank"
          href={`/api/shares/${shareId}/files/${fileId}?download=false`}
        >
          View original file
        </Button>
      )}
    </Stack>
  );
};

const FileTypeDetector = () => {
  const {
    shareId,
    fileId,
    fileSizeBytes,
    e2eKey,
    setMimeType,
    setIsNotSupported,
  } = React.useContext(FilePreviewContext);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    fetchPreviewPrefix(
      shareId,
      fileId,
      e2eKey,
      MIME_SNIFF_BYTES,
      controller.signal,
    )
      .then((prefix) => {
        if (!active) return;
        const detected = sniffPreviewMimeType(new Uint8Array(prefix));
        if (
          detected &&
          isPreviewMimeTypeSupported(detected, {
            fileSizeBytes,
            isE2EEncrypted: Boolean(e2eKey),
          })
        ) {
          setMimeType(detected);
        } else {
          setIsNotSupported(true);
        }
      })
      .catch(() => {
        if (active && !controller.signal.aborted) setIsNotSupported(true);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [shareId, fileId, fileSizeBytes, e2eKey, setMimeType, setIsNotSupported]);

  return (
    <Center style={{ minHeight: 200 }}>
      <Loader />
    </Center>
  );
};

const FileDecider = () => {
  const { mimeType, setIsNotSupported } = React.useContext(FilePreviewContext);

  if (mimeType == "application/pdf") {
    return <PdfPreview />;
  } else if (mimeType.startsWith("video/")) {
    return <VideoPreview />;
  } else if (mimeType.startsWith("image/")) {
    return <ImagePreview />;
  } else if (mimeType.startsWith("audio/")) {
    return <AudioPreview />;
  } else if (
    mimeType === "text/markdown" ||
    mimeType === "text/plain" ||
    mimeType === "text/x-markdown"
  ) {
    return <TextPreview />;
  } else if (isTextBasedMimeType(mimeType)) {
    return <CodePreview />;
  } else {
    setIsNotSupported(true);
    return null;
  }
};

const AudioPreview = () => {
  const { shareId, fileId, e2eKey, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const { blobUrl, loading } = useDecryptedBlobUrl("audio/mpeg");

  if (e2eKey && loading)
    return (
      <Center style={{ minHeight: 200 }}>
        <Loader />
      </Center>
    );

  const src =
    e2eKey && blobUrl
      ? blobUrl
      : `/api/shares/${shareId}/files/${fileId}?download=false`;

  return (
    <Center style={{ minHeight: 200 }}>
      <Stack align="center" gap={10} style={{ width: "100%" }}>
        <audio controls style={{ width: "100%" }}>
          <source src={src} onError={() => setIsNotSupported(true)} />
        </audio>
      </Stack>
    </Center>
  );
};

const VideoPreview = () => {
  const { shareId, fileId, mimeType, e2eKey, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const videoMime = normalizeVideoMime(mimeType);
  const { blobUrl, loading } = useDecryptedBlobUrl(videoMime);

  if (e2eKey && loading)
    return (
      <Center style={{ minHeight: 200 }}>
        <Loader />
      </Center>
    );

  const src =
    e2eKey && blobUrl
      ? blobUrl
      : `/api/shares/${shareId}/files/${fileId}?download=false`;

  return (
    <video width="100%" controls>
      <source
        src={src}
        type={videoMime}
        onError={() => setIsNotSupported(true)}
      />
    </video>
  );
};

const ImagePreview = () => {
  const { shareId, fileId, mimeType, e2eKey, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const { blobUrl, loading } = useDecryptedBlobUrl(mimeType);

  if (e2eKey && loading)
    return (
      <Center style={{ minHeight: 200 }}>
        <Loader />
      </Center>
    );

  const src =
    e2eKey && blobUrl
      ? blobUrl
      : `/api/shares/${shareId}/files/${fileId}?download=false`;

  return (
    <img
      src={src}
      alt={`${fileId}_preview`}
      width="100%"
      loading="lazy"
      onError={() => setIsNotSupported(true)}
    />
  );
};

const TextPreview = () => {
  const { shareId, fileId, e2eKey, mimeType } =
    React.useContext(FilePreviewContext);
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const { colorScheme } = useMantineColorScheme();
  const isPlainText = mimeType === "text/plain";

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    fetchPreviewPrefix(
      shareId,
      fileId,
      e2eKey,
      MAX_TEXT_PREVIEW_BYTES,
      controller.signal,
    )
      .then((buf) => {
        if (!active) return;
        const decoded = new TextDecoder().decode(buf);
        setText(
          truncateForPreview(decoded) || "Impossible de charger l'aperçu.",
        );
      })
      .catch(() => {
        if (active && !controller.signal.aborted) {
          setText("Impossible de charger l'aperçu.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [shareId, fileId, e2eKey]);

  if (loading)
    return (
      <Center style={{ minHeight: 200 }}>
        <Loader />
      </Center>
    );

  const options: MarkdownToJSX.Options = {
    disableParsingRawHTML: true,
    overrides: {
      pre: {
        props: {
          style: {
            backgroundColor:
              colorScheme == "dark"
                ? "rgba(50, 50, 50, 0.5)"
                : "rgba(220, 220, 220, 0.5)",
            padding: "0.75em",
            whiteSpace: "pre-wrap",
          },
        },
      },
      table: {
        props: {
          className: "md",
        },
      },
    },
  };

  if (isPlainText) {
    return (
      <ScrollArea styles={{ root: { maxHeight: "70vh", overflow: "auto" } }}>
        <pre
          style={{
            backgroundColor:
              colorScheme == "dark"
                ? "rgba(30, 30, 30, 0.9)"
                : "rgba(245, 245, 245, 0.9)",
            color: colorScheme == "dark" ? "#d4d4d4" : "#1e1e1e",
            padding: "1em",
            borderRadius: "8px",
            fontSize: "0.85em",
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "inherit",
            margin: 0,
          }}
        >
          {text}
        </pre>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea styles={{ root: { maxHeight: "70vh", overflow: "auto" } }}>
      <Markdown options={options}>{text}</Markdown>
    </ScrollArea>
  );
};

const CodePreview = () => {
  const { shareId, fileId, e2eKey } = React.useContext(FilePreviewContext);
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const { colorScheme } = useMantineColorScheme();

  useEffect(() => {
    if (e2eKey) {
      fetchDecryptedFile(shareId, fileId, e2eKey)
        .then((buf) =>
          setText(truncateForPreview(new TextDecoder().decode(buf))),
        )
        .catch(() => setText("Impossible de charger l'aperçu."))
        .finally(() => setLoading(false));
    } else {
      // responseType: "text" prevents Axios from auto-parsing JSON files
      // into objects (which would crash React — error #31).
      api
        .get(`/shares/${shareId}/files/${fileId}?download=false`, {
          responseType: "text",
        })
        .then((res) =>
          setText(
            truncateForPreview(ensureString(res.data)) ||
              "Impossible de charger l'aperçu.",
          ),
        )
        .finally(() => setLoading(false));
    }
  }, [shareId, fileId, e2eKey]);

  if (loading)
    return (
      <Center style={{ minHeight: 200 }}>
        <Loader />
      </Center>
    );

  return (
    <ScrollArea styles={{ root: { maxHeight: "70vh", overflow: "auto" } }}>
      <pre
        style={{
          backgroundColor:
            colorScheme == "dark"
              ? "rgba(30, 30, 30, 0.9)"
              : "rgba(245, 245, 245, 0.9)",
          color: colorScheme == "dark" ? "#d4d4d4" : "#1e1e1e",
          padding: "1em",
          borderRadius: "8px",
          fontSize: "0.85em",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily:
            '"Fira Code", "Cascadia Code", "JetBrains Mono", Consolas, Monaco, monospace',
          margin: 0,
          overflow: "auto",
        }}
      >
        <code>{text}</code>
      </pre>
    </ScrollArea>
  );
};

const PdfPreview = () => {
  const { shareId, fileId, e2eKey, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const { blobUrl, loading } = useDecryptedBlobUrl("application/pdf");
  const isMobile = useMediaQuery("(max-width: 48em)");

  if (e2eKey && loading)
    return (
      <Center style={{ minHeight: 200 }}>
        <Loader />
      </Center>
    );

  const src =
    e2eKey && blobUrl
      ? blobUrl
      : `/api/shares/${shareId}/files/${fileId}?download=false`;

  if (isMobile) {
    return (
      <Center style={{ minHeight: 200 }}>
        <Stack align="center" gap="md">
          <Text c="dimmed" size="sm" ta="center">
            <FormattedMessage id="share.modal.file-preview.pdf-mobile" />
          </Text>
          <Button
            component="a"
            href={src}
            target="_blank"
            rel="noopener noreferrer"
          >
            <FormattedMessage id="share.modal.file-preview.pdf-open" />
          </Button>
        </Stack>
      </Center>
    );
  }

  return (
    <iframe
      src={src}
      title="PDF preview"
      width="100%"
      style={{ minHeight: "70vh", border: "none" }}
      onError={() => setIsNotSupported(true)}
    />
  );
};

const UnSupportedFile = () => {
  return (
    <Center style={{ minHeight: 200 }}>
      <Stack align="center" gap={10}>
        <Title order={3}>
          <FormattedMessage id="share.modal.file-preview.error.not-supported.title" />
        </Title>
        <Text>
          <FormattedMessage id="share.modal.file-preview.error.not-supported.description" />
        </Text>
      </Stack>
    </Center>
  );
};

export default FilePreview;
