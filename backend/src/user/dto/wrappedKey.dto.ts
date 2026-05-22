import { IsString, Matches, MaxLength } from "class-validator";

export class WrappedKeyDTO {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: "credentialId must be a valid base64url string",
  })
  @MaxLength(512)
  credentialId: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: "wrappedKey must be a valid base64url string",
  })
  @MaxLength(512)
  wrappedKey: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: "salt must be a valid base64url string",
  })
  @MaxLength(512)
  salt: string;
}
