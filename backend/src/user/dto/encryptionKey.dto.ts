import { IsString, Matches } from "class-validator";

export class EncryptionKeyHashDTO {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/, {
    message: "keyHash must be a valid SHA-256 hex string (64 hex chars)",
  })
  keyHash: string;
}
