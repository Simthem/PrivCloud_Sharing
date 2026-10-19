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
    title: file.name,
    styles: { body: { maxHeight: "calc(85vh - 80px)", overflow: "auto" } },
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
