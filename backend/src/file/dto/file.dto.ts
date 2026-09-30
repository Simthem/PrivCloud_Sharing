import { Expose, plainToClass } from "class-transformer";
import { ShareDTO } from "src/share/dto/share.dto";

export class FileDTO {
  @Expose()
  id: string;

  @Expose()
  name: string;

  @Expose()
  relativePath?: string;

  @Expose()
  size: string;

  @Expose()
  encryptionChunkSize?: number;

  // FILE_META_V1: `name` is a placeholder, the real name and folder path are
  // in `encryptedMetadata`, which only the holder of K_share can open.
  @Expose()
  metadataScheme?: number | null;

  @Expose()
  encryptedMetadata?: string | null;

  share: ShareDTO;

  from(partial: Partial<FileDTO>) {
    return plainToClass(FileDTO, partial, { excludeExtraneousValues: true });
  }
}
