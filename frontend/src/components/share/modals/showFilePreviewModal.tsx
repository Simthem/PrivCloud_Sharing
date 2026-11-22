import { Text } from "@mantine/core";
import { useModals } from "@mantine/modals";
import { FileMetaData } from "../../../types/File.type";
import FilePreview from "../FilePreview";
import { resolveFileMimeType } from "../../../services/share.service";

const showFilePreviewModal = (
  shareId: string,
  file: FileMetaData,
  modals: ReturnType<typeof useModals>,
  e2eKey?: string | null,
) => {
  const mimeType = resolveFileMimeType(file.name);
  return modals.openModal({
    size: "min(1120px, 94vw)",
    title: (
      <Text inherit truncate="end" title={file.name}>
        {file.name}
      </Text>
    ),
    // Viewers shrink to fit so the dialog itself does not scroll.
    styles: {
      content: { display: "flex", flexDirection: "column" },
      title: { minWidth: 0 },
      body: {
        display: "flex",
        flexDirection: "column",
        flex: "1 1 auto",
        minHeight: 0,
        overflowY: "auto",
      },
    },
    children: (
      <FilePreview
        shareId={shareId}
        fileId={file.id}
        mimeType={mimeType}
        fileName={file.name}
        fileSizeBytes={Number(file.size)}
        e2eKey={e2eKey}
      />
    ),
  });
};

export default showFilePreviewModal;
