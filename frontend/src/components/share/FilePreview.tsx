import {
  Button,
  Center,
  Loader,
  ScrollArea,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import Markdown, { MarkdownToJSX } from "markdown-to-jsx";
import Link from "next/link";
import React, { Dispatch, SetStateAction, useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import api from "../../services/api.service";
import { fetchDecryptedFile } from "../../services/share.service";

/**
 * MIME types that are safe to preview as raw text / code.
 * These are non-dangerous structured or code files with
 * application/* MIME types (text/* is already handled).
 */
const TEXT_SAFE_APPLICATION_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/manifest+json",
  "application/schema+json",
  "application/vnd.api+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/typescript",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-python",
  "application/x-perl",
  "application/x-ruby",
  "application/x-php",
  "application/x-httpd-php",
  "application/sql",
  "application/graphql",
  "application/toml",
  "application/x-toml",
  "application/yaml",
  "application/x-yaml",
  "application/x-latex",
  "application/x-tex",
  "application/x-csh",
]);

/**
 * Returns true when the given MIME type is safe (no XSS / code execution
 * risk when rendered as plain text) and can be previewed in the browser.
 */
export const isTextBasedMimeType = (mimeType: string): boolean => {
  if (mimeType.startsWith("text/")) return true;
  if (TEXT_SAFE_APPLICATION_TYPES.has(mimeType)) return true;
  // Structured suffixes: application/vnd.foo+json, +xml, +yaml
  if (/^application\/.*\+(json|xml|yaml)$/.test(mimeType)) return true;
  return false;
};

const FilePreviewContext = React.createContext<{
  shareId: string;
  fileId: string;
  mimeType: string;
  e2eKey?: string | null;
  setIsNotSupported: Dispatch<SetStateAction<boolean>>;
}>({
  shareId: "",
  fileId: "",
  mimeType: "",
  e2eKey: null,
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
    let revoke: string | null = null;
    fetchDecryptedFile(shareId, fileId, e2eKey)
      .then((decrypted) => {
        const blob = new Blob([decrypted], { type: mimeType });
        const url = URL.createObjectURL(blob);
        revoke = url;
        setBlobUrl(url);
      })
      .catch(() => setIsNotSupported(true))
      .finally(() => setLoading(false));
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [shareId, fileId, e2eKey, mimeType, setIsNotSupported]);

  return { blobUrl, loading };
};

const FilePreview = ({
  shareId,
  fileId,
  mimeType,
  e2eKey,
}: {
  shareId: string;
  fileId: string;
  mimeType: string;
  e2eKey?: string | null;
}) => {
  const [isNotSupported, setIsNotSupported] = useState(false);
  if (isNotSupported) return <UnSupportedFile />;

  return (
    <Stack>
      <FilePreviewContext.Provider
        value={{ shareId, fileId, mimeType, e2eKey, setIsNotSupported }}
      >
        <FileDecider />
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
      <Stack align="center" spacing={10} style={{ width: "100%" }}>
        <audio controls style={{ width: "100%" }}>
          <source src={src} onError={() => setIsNotSupported(true)} />
        </audio>
      </Stack>
    </Center>
  );
};

const VideoPreview = () => {
  const { shareId, fileId, e2eKey, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const { blobUrl, loading } = useDecryptedBlobUrl("video/mp4");

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
      <source src={src} onError={() => setIsNotSupported(true)} />
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
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={`${fileId}_preview`}
      width="100%"
      onError={() => setIsNotSupported(true)}
    />
  );
};

const TextPreview = () => {
  const { shareId, fileId, e2eKey } = React.useContext(FilePreviewContext);
  const [text, setText] = useState<string>("");
  const { colorScheme } = useMantineTheme();

  useEffect(() => {
    if (e2eKey) {
      fetchDecryptedFile(shareId, fileId, e2eKey)
        .then((buf) => {
          const decoded = new TextDecoder().decode(buf);
          setText(decoded);
        })
        .catch(() => setText("Preview couldn't be fetched."));
    } else {
      api
        .get(`/shares/${shareId}/files/${fileId}?download=false`)
        .then((res) => setText(res.data ?? "Preview couldn't be fetched."));
    }
  }, [shareId, fileId, e2eKey]);

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

  return <Markdown options={options}>{text}</Markdown>;
};

const CodePreview = () => {
  const { shareId, fileId, e2eKey } = React.useContext(FilePreviewContext);
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const { colorScheme } = useMantineTheme();

  useEffect(() => {
    if (e2eKey) {
      fetchDecryptedFile(shareId, fileId, e2eKey)
        .then((buf) => setText(new TextDecoder().decode(buf)))
        .catch(() => setText("Preview couldn't be fetched."))
        .finally(() => setLoading(false));
    } else {
      api
        .get(`/shares/${shareId}/files/${fileId}?download=false`)
        .then((res) => setText(res.data ?? "Preview couldn't be fetched."))
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
    <ScrollArea style={{ maxHeight: "70vh" }}>
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
      <Stack align="center" spacing={10}>
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
