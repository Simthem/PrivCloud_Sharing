import { Expose, plainToClass } from "class-transformer";

export class ReverseShareDTO {
  @Expose()
  id: string;

  @Expose()
  name?: string;

  // Name encrypted with K_rs: the holders of the link open it in the browser.
  @Expose()
  encryptedName?: string | null;

  @Expose()
  maxShareSize: string;

  @Expose()
  shareExpiration: Date;

  @Expose()
  token: string;

  @Expose()
  simplified: boolean;

  @Expose()
  publicAccess: boolean;

   // E2E: indicates whether the reverse share expects encrypted files
  @Expose()
  isE2EEncrypted: boolean;

  // FILE_META_V1: uploads encrypt their file names and title with K_rs.
  @Expose()
  fileMetaV1Write?: boolean;

  from(partial: Partial<ReverseShareDTO>) {
    const result = plainToClass(ReverseShareDTO, partial, {
      excludeExtraneousValues: true,
    });
     // Derived: a reverse share is E2E if it has an encryptedReverseShareKey
    result.isE2EEncrypted = !!(partial as Record<string, unknown>).encryptedReverseShareKey;
    return result;
  }
}
