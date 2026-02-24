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

  // E2E: indique si le reverse share attend des fichiers chiffrés
  @Expose()
  isE2EEncrypted: boolean;

  from(partial: Partial<ReverseShareDTO>) {
    const result = plainToClass(ReverseShareDTO, partial, {
      excludeExtraneousValues: true,
    });
    // Dérivé : un reverse share est E2E s'il a une encryptedReverseShareKey
    result.isE2EEncrypted = !!(partial as any).encryptedReverseShareKey;
    return result;
  }
}
