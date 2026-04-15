import { IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class UpdateReverseShareDTO {
  @IsString()
  @IsOptional()
  shareExpiration?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: "encryptedReverseShareKey must be valid base64url",
  })
  encryptedReverseShareKey?: string;
}
