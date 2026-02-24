import { Expose, plainToClass } from "class-transformer";

export class ShareMetaDataDTO {
  @Expose()
  id: string;

  @Expose()
  isZipReady: boolean;

  @Expose()
  isE2EEncrypted: boolean;

  from(partial: Partial<ShareMetaDataDTO>) {
    return plainToClass(ShareMetaDataDTO, partial, {
      excludeExtraneousValues: true,
    });
  }
}
