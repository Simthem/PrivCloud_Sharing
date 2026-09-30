import { Expose, plainToClass, Type } from "class-transformer";
import { FileDTO } from "src/file/dto/file.dto";
import { PublicUserDTO } from "src/user/dto/publicUser.dto";

export class ShareDTO {
  @Expose()
  id: string;

  @Expose()
  name?: string;

  @Expose()
  expiration: Date;

  @Expose()
  createdAt: Date;

  @Expose()
  @Type(() => FileDTO)
  files: FileDTO[];

  @Expose()
  @Type(() => PublicUserDTO)
  creator: PublicUserDTO;

  @Expose()
  description: string;

  @Expose()
  hasPassword: boolean;

  @Expose()
  isE2EEncrypted: boolean;

  // NULL means LEGACY_ACCOUNT_KEY. Not a secret: it only tells the owner's
  // client how to resolve the key, the recipient always uses the link.
  @Expose()
  cryptoScheme?: number | null;

  // NULL: file names in clear. FILE_META_V1 (1): every file carries its name
  // encrypted with K_share, readable only with the link key.
  @Expose()
  fileMetadataScheme?: number | null;

  @Expose()
  previewEnabled?: boolean;

  @Expose()
  encryptedReverseShareKey?: string;

  @Expose()
  teamFolderId?: string;

  @Expose()
  teamId?: string;

  @Expose()
  size: number;

  from(partial: Partial<ShareDTO>) {
    return plainToClass(ShareDTO, partial, { excludeExtraneousValues: true });
  }

  fromList(partial: Partial<ShareDTO>[]) {
    return partial.map((part) =>
      plainToClass(ShareDTO, part, { excludeExtraneousValues: true }),
    );
  }
}
