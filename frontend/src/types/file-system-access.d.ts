/**
 * File System Access API type declarations.
 * These interfaces are not yet included in the default TypeScript DOM lib.
 */

interface FileSystemFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(
    options?: FileSystemCreateWritableOptions,
  ): Promise<FileSystemWritableFileStream>;
  remove?(): Promise<void>;
}

interface FileSystemCreateWritableOptions {
  keepExistingData?: boolean;
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: FileSystemWriteChunkType): Promise<void>;
  seek(position: number): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

type FileSystemWriteChunkType =
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | string
  | { type: "write"; position?: number; data: ArrayBuffer | ArrayBufferView | Blob | string }
  | { type: "seek"; position: number }
  | { type: "truncate"; size: number };

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

interface Window {
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}
