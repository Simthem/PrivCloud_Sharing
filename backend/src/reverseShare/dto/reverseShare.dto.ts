import { Expose, plainToClass } from "class-transformer";

export class ReverseShareDTO {
  @Expose()
  id: string;

  @Expose()
  name?: string;

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

  from(partial: Partial<ReverseShareDTO>) {
    const result = plainToClass(ReverseShareDTO, partial, {
      excludeExtraneousValues: true,
    });
     // Derived: a reverse share is E2E if it has an encryptedReverseShareKey
    result.isE2EEncrypted = !!(partial as Record<string, unknown>).encryptedReverseShareKey;
    return result;
  }
}
