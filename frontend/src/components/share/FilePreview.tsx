import {
  Button,
  Center,
  Loader,
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
  } else if (mimeType.startsWith("text/")) {
    return <TextPreview />;
  } else {
    setIsNotSupported(true);
    return null;
  }
};

const AudioPreview = () => {
  const { shareId, fileId, e2eKey, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const { blobUrl, loading } = useDecryptedBlobUrl("audio/mpeg");

  if (e2eKey && loading) return <Center style={{ minHeight: 200 }}><Loader /></Center>;

  const src = e2eKey && blobUrl ? blobUrl : `/api/shares/${shareId}/files/${fileId}?download=false`;

  return (
    <Center style={{ minHeight: 200 }}>
      <Stack align="center" spacing={10} style={{ width: "100%" }}>
        <audio controls style={{ width: "100%" }}>
          <source
            src={src}
            onError={() => setIsNotSupported(true)}
          />
        </audio>
      </Stack>
    </Center>
  );
};

const VideoPreview = () => {
  const { shareId, fileId, e2eKey, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const { blobUrl, loading } = useDecryptedBlobUrl("video/mp4");

  if (e2eKey && loading) return <Center style={{ minHeight: 200 }}><Loader /></Center>;

  const src = e2eKey && blobUrl ? blobUrl : `/api/shares/${shareId}/files/${fileId}?download=false`;

  return (
    <video width="100%" controls>
      <source
        src={src}
        onError={() => setIsNotSupported(true)}
      />
    </video>
  );
};

const ImagePreview = () => {
  const { shareId, fileId, mimeType, e2eKey, setIsNotSupported } =
    React.useContext(FilePreviewContext);
  const { blobUrl, loading } = useDecryptedBlobUrl(mimeType);

  if (e2eKey && loading) return <Center style={{ minHeight: 200 }}><Loader /></Center>;

  const src = e2eKey && blobUrl ? blobUrl : `/api/shares/${shareId}/files/${fileId}?download=false`;

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

const PdfPreview = () => {
  const { shareId, fileId, e2eKey, setIsNotSupported } = React.useContext(FilePreviewContext);

  useEffect(() => {
    if (e2eKey) {
      // PDF preview not supported for E2E encrypted files (browser needs direct URL)
      setIsNotSupported(true);
    } else if (typeof window !== "undefined") {
      window.location.href = `/api/shares/${shareId}/files/${fileId}?download=false`;
    }
  }, [shareId, fileId, e2eKey, setIsNotSupported]);

  return null;
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
