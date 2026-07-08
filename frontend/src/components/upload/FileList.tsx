import { ActionIcon, Table } from "@mantine/core";
import { TbTrash } from "react-icons/tb";
import { GrUndo } from "react-icons/gr";
import { FileListItem } from "../../types/File.type";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import { getFileDisplayPath } from "../../utils/uploadPath.util";
import UploadProgressIndicator from "./UploadProgressIndicator";
import { FormattedMessage } from "react-intl";

const FileListRow = ({
  file,
  onRemove,
  onRestore,
}: {
  file: FileListItem;
  onRemove?: () => void;
  onRestore?: () => void;
}) => {
  {
    const uploadable = "uploadingProgress" in file;
    const uploading = uploadable && file.uploadingProgress !== 0;
    const removable = uploadable
      ? file.uploadingProgress === 0
      : onRemove && !file.deleted;
    const restorable = onRestore && !uploadable && !!file.deleted; // maybe undefined, force boolean
    const deleted = !uploadable && !!file.deleted;

    return (
      <tr
        style={{
          color: deleted ? "rgba(120, 120, 120, 0.5)" : "inherit",
          textDecoration: deleted ? "line-through" : "none",
        }}
      >
        <td>{getFileDisplayPath(file)}</td>
        <td>{byteToHumanSizeString(+file.size)}</td>
        <td>
          {removable && (
            <ActionIcon
              color="red"
              variant="light"
              size={25}
              onClick={onRemove}
            >
              <TbTrash />
            </ActionIcon>
          )}
          {uploading && (
            <UploadProgressIndicator progress={file.uploadingProgress} />
          )}
          {restorable && (
            <ActionIcon
              color="primary"
              variant="light"
              size={25}
              onClick={onRestore}
            >
              <GrUndo />
            </ActionIcon>
          )}
        </td>
      </tr>
    );
  }
};

const FileList = <T extends FileListItem = FileListItem>({
  files,
  setFiles,
  isUploading = false,
}: {
  files: T[];
  setFiles: (_files: T[]) => void;
  isUploading?: boolean;
}) => {
  const remove = (index: number) => {
    const file = files[index];

    if ("uploadingProgress" in file) {
      files.splice(index, 1);
    } else {
      files[index] = { ...file, deleted: true };
    }

    setFiles([...files]);
  };

  const restore = (index: number) => {
    const file = files[index];

    if ("uploadingProgress" in file) {
      return;
    } else {
      files[index] = { ...file, deleted: false };
    }

    setFiles([...files]);
  };

  const rows = files.map((file, i) => (
    <FileListRow
      key={i}
      file={file}
      onRemove={() => remove(i)}
      onRestore={() => restore(i)}
    />
  ));

  return (
    <div style={isUploading ? { opacity: 0.6, pointerEvents: "none" } : undefined}>
    <Table>
      <thead>
        <tr>
          <th style={{ textAlign: "left" }}>
            <FormattedMessage id="upload.filelist.name" />
          </th>
          <th style={{ textAlign: "left" }}>
            <FormattedMessage id="upload.filelist.size" />
          </th>
          <th></th>
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </Table>
    </div>
  );
};

export default FileList;
