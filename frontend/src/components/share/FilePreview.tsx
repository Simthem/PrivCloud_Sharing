import ZoomablePreview from "./ZoomablePreview";
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
import { modals } from "@mantine/modals";
import type { MarkdownToJSX } from "markdown-to-jsx";
import dynamic from "next/dynamic";

const Markdown = dynamic(() => import("markdown-to-jsx"), { ssr: false });
import React, { Dispatch, SetStateAction, useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  fetchDecryptedFile,
  fetchFileBuffer,
  fetchFilePreviewSource,
} from "../../services/share.service";
import {
  E2E_BLOB_PREVIEW_MAX_SIZE,
  isOfficePreviewMimeType,
  isPreviewMimeTypeSupported,
  isTextBasedMimeType,
  sniffPreviewMimeType,
} from "../../utils/filePreview.util";

import { decodePreviewText } from "../../utils/textPreview.util";
import { resolveCodeLanguage } from "../../utils/codePreview.util";
const SourceCodePreview = dynamic(() => import("./SourceCodePreview"), {
  ssr: false,
});

import { createProgressiveMediaUrl } from "../../utils/previewMedia.util";
import type { PreviewByteSource } from "../../utils/previewRange.util";
import { readRawRangePreview } from "../../utils/rawPreview.util";
import {
  toDisplayableImageBlob,
  toDisplayableDecodedImageBlob,
} from "../../utils/imageDecoder.util";
import {
  DECODED_IMAGE_MAX_SOURCE_BYTES,
  imageDecoderFormat,
} from "../../utils/imageFormats.util";
const OfficePreview = dynamic(() => import("./OfficePreview"), { ssr: false });
const ProgressivePdfPreview = dynamic(() => import("./ProgressivePdfPreview"), {
  ssr: false,
});
const VideoPlayer = dynamic(() => import("./VideoPlayer"), {
  ssr: false,
  loading: () => (
    <Center mih={200}>
      <Loader />
    </Center>
  ),
});

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
): Promise<{ buffer: ArrayBuffer; truncated: boolean }> => {
  const source = await fetchFilePreviewSource(shareId, fileId, e2eKey, signal);
  const bytes = await source.read(0, Math.min(maxBytes, source.size), signal);
  return { buffer: bytes.buffer, truncated: source.size > maxBytes };
};

/** Truncate a string if it exceeds the safe preview limit. */
const truncateForPreview = (s: string): string =>
  s.length > MAX_TEXT_PREVIEW_CHARS
    ? s.slice(0, MAX_TEXT_PREVIEW_CHARS) +
      "\n\n[... truncated, file too large for preview]"
    : s;

/**
 * Normalise vendor video MIME types to standard ones so the browser
 * recognises them in Blob and &lt;source type&gt;.
 * e.g. video/x-m4v -> video/mp4  (M4V is just an MP4 container)
 */
const normalizeVideoMime = (m: string): string => {
  if (m === "video/x-m4v" || m === "video/x-mp4") return "video/mp4";
  return m;
};

const FilePreviewContext = React.createContext<{
  shareId: string;
  fileId: string;
  mimeType: string;
  fileName?: string;
  fileSizeBytes?: number;
  e2eKey?: string | null;
  setMimeType: Dispatch<SetStateAction<string>>;
  setIsNotSupported: Dispatch<SetStateAction<boolean>>;
}>({
  shareId: "",
  fileId: "",
  mimeType: "",
  fileName: "",
  fileSizeBytes: undefined,
  e2eKey: null,
  setMimeType: () => {},
  setIsNotSupported: () => {},
});

/** Hook: fetch (and decrypt or decode) the image, return a blob URL */
const useDecryptedBlobUrl = (mimeType: string) => {
  const { shareId, fileId, e2eKey, fileSizeBytes, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // HEIC, TIFF and RAW reach the <img> only once decoded on the device.
  const needsDecoding = imageDecoderFormat(mimeType) !== null;

  useEffect(() => {
    if (!e2eKey && !needsDecoding) {
      setLoading(false);
      return;
    }
    if (
      needsDecoding &&
      imageDecoderFormat(mimeType) !== "raw" &&
      fileSizeBytes != null &&
      fileSizeBytes > DECODED_IMAGE_MAX_SOURCE_BYTES
    ) {
      setIsNotSupported(true);
      setLoading(false);
      return;
    }
    if (
      e2eKey &&
      imageDecoderFormat(mimeType) !== "raw" &&
      fileSizeBytes != null &&
      fileSizeBytes > E2E_BLOB_PREVIEW_MAX_SIZE
    ) {
      setIsNotSupported(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    setBlobUrl(null);
    const controller = new AbortController();
    let active = true;
    let revoke: string | null = null;
    (async () => {
      if (imageDecoderFormat(mimeType) === "raw") {
        const source = await fetchFilePreviewSource(
          shareId,
          fileId,
          e2eKey,
          controller.signal,
        );
        const preview = await readRawRangePreview(source, controller.signal);
        if (preview?.kind === "jpeg")
          return toDisplayableDecodedImageBlob(
            preview.decoded,
            controller.signal,
          );
        if (preview?.kind === "tiff")
          return toDisplayableImageBlob(
            preview.bytes,
            "image/tiff",
            controller.signal,
          );
        // Proprietary layouts retain the existing bounded decoder fallback.
        if (source.size > DECODED_IMAGE_MAX_SOURCE_BYTES)
          throw new Error("RAW preview unavailable within memory budget");
      }
      const buffer = e2eKey
        ? await fetchDecryptedFile(shareId, fileId, e2eKey, controller.signal)
        : await fetchFileBuffer(shareId, fileId, controller.signal);
      return toDisplayableImageBlob(buffer, mimeType, controller.signal);
    })()
      .then((blob) => {
        if (!active) return;
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
  }, [
    shareId,
    fileId,
    e2eKey,
    fileSizeBytes,
    mimeType,
    needsDecoding,
    setIsNotSupported,
  ]);

  return { blobUrl, loading, needsBlob: Boolean(e2eKey) || needsDecoding };
};

/**
 * Media elements read and seek through a local, ephemeral range URL, served
 * from one authenticated source. Video waits for its codec decision before
 * starting a media element or registering a service worker.
 */
const useProgressiveMediaUrl = (needsMediaUrl = true) => {
  const { shareId, fileId, mimeType, e2eKey, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const [media, setMedia] = useState<{
    src: string;
    source: PreviewByteSource | null;
  } | null>(null);
  useEffect(() => {
    const fallback = !e2eKey
      ? `/api/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(fileId)}?download=false`
      : null;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    setMedia(null);
    (async () => {
      const source = await fetchFilePreviewSource(
        shareId,
        fileId,
        e2eKey,
        controller.signal,
      );
      if (!needsMediaUrl) {
        if (!controller.signal.aborted)
          setMedia({
            source,
            src: fallback ?? "",
          });
        return;
      }
      const media = await createProgressiveMediaUrl(
        source,
        normalizeVideoMime(mimeType),
        controller.signal,
      );
      release = media.release;
      if (!controller.signal.aborted) setMedia({ src: media.url, source });
      else release();
    })().catch(() => {
      if (controller.signal.aborted) return;
      if (needsMediaUrl && fallback) setMedia({ src: fallback, source: null });
      else setIsNotSupported(true);
    });
    return () => {
      controller.abort();
      release?.();
    };
  }, [shareId, fileId, mimeType, e2eKey, needsMediaUrl, setIsNotSupported]);
  return media;
};

const FilePreview = ({
  shareId,
  fileId,
  mimeType,
  fileName,
  fileSizeBytes,
  e2eKey,
}: {
  shareId: string;
  fileId: string;
  mimeType: string;
  fileName?: string;
  fileSizeBytes?: number;
  e2eKey?: string | null;
}) => {
  const [isNotSupported, setIsNotSupported] = useState(false);
  const [resolvedMimeType, setResolvedMimeType] = useState(mimeType);

  useEffect(() => {
    setResolvedMimeType(mimeType);
    setIsNotSupported(false);
  }, [mimeType, shareId, fileId, e2eKey]);

  if (isNotSupported)
    return (
      <UnSupportedFile readError={isOfficePreviewMimeType(resolvedMimeType)} />
    );

  return (
    <Stack>
      <FilePreviewContext.Provider
        value={{
          shareId,
          fileId,
          mimeType: resolvedMimeType,
          fileName,
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
          component="a"
          onClick={() => modals.closeAll()}
          target="_blank"
          rel="noopener noreferrer"
          href={`/api/shares/${shareId}/files/${fileId}?download=false`}
        >
          <FormattedMessage id="share.modal.file-preview.view-original" />
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
      .then(({ buffer: prefix }) => {
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
  const { mimeType, fileName } = React.useContext(FilePreviewContext);

  if (isOfficePreviewMimeType(mimeType)) {
    return <OfficeFilePreview />;
  } else if (mimeType == "application/pdf") {
    return <PdfPreview />;
  } else if (mimeType.startsWith("video/")) {
    return <VideoPreview />;
  } else if (mimeType.startsWith("image/")) {
    return <ImagePreview />;
  } else if (mimeType.startsWith("audio/")) {
    return <AudioPreview />;
  } else if (
    isTextBasedMimeType(mimeType) &&
    resolveCodeLanguage(fileName, mimeType)
  ) {
    return <CodePreview />;
  } else if (
    mimeType === "text/markdown" ||
    mimeType === "text/plain" ||
    mimeType === "text/x-markdown"
  ) {
    return <TextPreview />;
  } else if (isTextBasedMimeType(mimeType)) {
    return <CodePreview />;
  } else {
    return <UnSupportedFile />;
  }
};

const AudioPreview = () => {
  const { setIsNotSupported } = React.useContext(FilePreviewContext);
  const media = useProgressiveMediaUrl();
  if (!media)
    return (
      <Center mih={200}>
        <Loader />
      </Center>
    );
  return (
    <Center mih={200}>
      <audio
        src={media.src}
        controls
        preload="metadata"
        style={{ width: "100%" }}
        onError={() => setIsNotSupported(true)}
      />
    </Center>
  );
};

const VideoPreview = () => {
  const { shareId, fileId, e2eKey, mimeType, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const media = useProgressiveMediaUrl(false);
  const [codec, setCodec] = useState<string | null>(null);
  useEffect(() => setCodec(null), [media]);
  const onUnsupported = React.useCallback(
    (name: string | null) => (name ? setCodec(name) : setIsNotSupported(true)),
    [setIsNotSupported],
  );
  if (!media)
    return (
      <Center mih={200}>
        <Loader />
      </Center>
    );
  if (codec) return <UnSupportedFile codec={codec} />;
  return (
    <VideoPlayer
      shareId={shareId}
      fileId={fileId}
      e2eKey={e2eKey}
      source={media.source}
      mediaSrc={media.src}
      mimeType={normalizeVideoMime(mimeType)}
      onUnsupported={onUnsupported}
    />
  );
};

const ImagePreview = () => {
  const { shareId, fileId, mimeType, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const { blobUrl, loading, needsBlob } = useDecryptedBlobUrl(mimeType);

  if (needsBlob && loading)
    return (
      <Center style={{ minHeight: 200 }}>
        <Loader />
      </Center>
    );

  const src =
    needsBlob && blobUrl
      ? blobUrl
      : `/api/shares/${shareId}/files/${fileId}?download=false`;

  return (
    <ZoomablePreview key={fileId}>
      <img
        src={src}
        alt={`${fileId}_preview`}
        draggable={false}
        style={{
          display: "block",
          width: "100%",
          maxWidth: "none",
          height: "auto",
        }}
        width="100%"
        loading="lazy"
        onError={() => setIsNotSupported(true)}
      />
    </ZoomablePreview>
  );
};

const TextPreview = () => {
  const { shareId, fileId, e2eKey, mimeType } =
    React.useContext(FilePreviewContext);
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const { colorScheme } = useMantineColorScheme();
  const truncatedMessage = useIntl().formatMessage({
    id: "share.modal.file-preview.partial",
    defaultMessage: "Partial preview. Download the file to view all content.",
  });
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
      .then(({ buffer: buf, truncated }) => {
        if (!active) return;
        const decoded = decodePreviewText(new Uint8Array(buf), truncated);
        const content =
          truncateForPreview(decoded) +
          (truncated ? "\n\n" + truncatedMessage : "");
        setText(content || "Impossible de charger l'aperçu.");
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
  }, [shareId, fileId, e2eKey, truncatedMessage]);

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
  const { shareId, fileId, e2eKey, mimeType, fileName } =
    React.useContext(FilePreviewContext);
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [partial, setPartial] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setText("");
    setPartial(false);

    fetchPreviewPrefix(
      shareId,
      fileId,
      e2eKey,
      MAX_TEXT_PREVIEW_BYTES,
      controller.signal,
    )
      .then(({ buffer: buf, truncated }) => {
        if (!active) return;
        const decoded = decodePreviewText(new Uint8Array(buf), truncated);
        setPartial(truncated || decoded.length > MAX_TEXT_PREVIEW_CHARS);
        setText(decoded.slice(0, MAX_TEXT_PREVIEW_CHARS));
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

  return (
    <ScrollArea styles={{ root: { maxHeight: "70vh", overflow: "auto" } }}>
      <SourceCodePreview
        text={text}
        partial={partial}
        language={resolveCodeLanguage(fileName, mimeType)}
      />
    </ScrollArea>
  );
};

const PdfPreview = () => {
  const { shareId, fileId, e2eKey, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const onError = React.useCallback(
    () => setIsNotSupported(true),
    [setIsNotSupported],
  );
  return (
    <ProgressivePdfPreview
      shareId={shareId}
      fileId={fileId}
      e2eKey={e2eKey}
      onError={onError}
    />
  );
};

const OfficeFilePreview = () => {
  const { shareId, fileId, mimeType, e2eKey, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const onError = React.useCallback(
    () => setIsNotSupported(true),
    [setIsNotSupported],
  );
  return (
    <OfficePreview
      shareId={shareId}
      fileId={fileId}
      mimeType={mimeType}
      e2eKey={e2eKey}
      onError={onError}
    />
  );
};

const UnSupportedFile = ({
  readError = false,
  codec,
}: {
  readError?: boolean;
  /** A video whose codec this browser cannot decode. */
  codec?: string;
}) => {
  if (codec)
    return (
      <Center style={{ minHeight: 200 }}>
        <Stack align="center" gap={10}>
          <Title order={3}>
            <FormattedMessage
              id="share.modal.file-preview.error.video-codec.title"
              defaultMessage="Unsupported video format"
            />
          </Title>
          <Text ta="center">
            <FormattedMessage
              id="share.modal.file-preview.error.video-codec.description"
              defaultMessage="This browser cannot play {codec} videos. Download the video to watch it."
              values={{ codec }}
            />
          </Text>
        </Stack>
      </Center>
    );
  return (
    <Center style={{ minHeight: 200 }}>
      <Stack align="center" gap={10}>
        <Title order={3}>
          <FormattedMessage
            id={
              readError
                ? "share.modal.file-preview.error.read-failed.title"
                : "share.modal.file-preview.error.not-supported.title"
            }
          />
        </Title>
        <Text>
          <FormattedMessage
            id={
              readError
                ? "share.modal.file-preview.error.read-failed.description"
                : "share.modal.file-preview.error.not-supported.description"
            }
          />
        </Text>
      </Stack>
    </Center>
  );
};

export default FilePreview;
