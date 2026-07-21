export type BridgeWebDavSource = {
  endpoint: string;
  username: string;
  password: string;
  href: string;
  contentType?: string;
  lastModified?: string;
};

export type FileUpload = File & {
  uploadingProgress: number;
  uploadRelativePath?: string;
  privcloudBridgeSource?: BridgeWebDavSource;
};

export type FileUploadResponse = {
  id: string;
  name: string;
  relativePath?: string | null;
  encryptionChunkSize?: number | null;
};

export type FileMetaData = {
  id: string;
  name: string;
  relativePath?: string | null;
  size: string;
  encryptionChunkSize?: number | null;
};

export type FileListItem = FileUpload | (FileMetaData & { deleted?: boolean });
