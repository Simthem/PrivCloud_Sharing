import { ModalsContextProps } from "@mantine/modals/lib/context";
import mime from "mime-types";
import { FileMetaData } from "../../../types/File.type";
import FilePreview from "../FilePreview";

const showFilePreviewModal = (
  shareId: string,
  file: FileMetaData,
  modals: ModalsContextProps,
  e2eKey?: string | null,
) => {
  const mimeType = (mime.contentType(file.name) || "").split(";")[0];
  return modals.openModal({
    size: "xl",
    title: file.name,
    children: (
      <FilePreview shareId={shareId} fileId={file.id} mimeType={mimeType} e2eKey={e2eKey} />
    ),
  });
};

export default showFilePreviewModal;
