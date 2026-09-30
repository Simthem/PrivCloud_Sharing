import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";
import {
  LEGACY_ACCOUNT_KEY,
  SHARE_DEK_V1,
  SHARE_KEY_WRAP_ALGORITHM,
  WRAPPED_SHARE_KEY_PATTERN,
} from "../share-crypto-scheme";
import { FILE_META_V1 } from "../../file/file-metadata-scheme";
import { ShareSecurityDTO } from "./shareSecurity.dto";

export class CreateShareDTO {
  @IsString()
  @Matches("^[a-zA-Z0-9_-]*$", undefined, {
    message: "ID can only contain letters, numbers, underscores and hyphens",
  })
  @Length(3, 50)
  id: string;

  @Length(3, 90)
  @IsOptional()
  name: string;

  @IsString()
  expiration: string;

  @MaxLength(512)
  @IsOptional()
  description: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  recipients: string[];

  @ValidateNested()
  @Type(() => ShareSecurityDTO)
  security: ShareSecurityDTO;

  @IsOptional()
  @IsBoolean()
  isE2EEncrypted: boolean;

  @IsOptional()
  @IsInt()
  @IsIn([LEGACY_ACCOUNT_KEY, SHARE_DEK_V1])
  cryptoScheme?: number;

  // K_share wrapped by K_master in the browser. Never K_share itself.
  @IsOptional()
  @IsString()
  @Matches(WRAPPED_SHARE_KEY_PATTERN, {
    message: "wrappedShareKey must be a 60-byte base64url value",
  })
  wrappedShareKey?: string;

  @IsOptional()
  @IsIn([SHARE_KEY_WRAP_ALGORITHM])
  wrappedShareKeyAlgorithm?: string;

  // FILE_META_V1: the browser encrypts every file name with K_share.
  @IsOptional()
  @IsInt()
  @IsIn([FILE_META_V1])
  fileMetadataScheme?: number;

  @IsOptional()
  @IsString()
  captchaToken?: string;

  @IsOptional()
  @IsString()
  @Length(2, 100)
  senderName?: string;

  @IsOptional()
  @IsEmail()
  senderEmail?: string;

  @IsOptional()
  @IsBoolean()
  notifyOnDownload?: boolean;

  @IsOptional()
  @IsUUID()
  teamFolderId?: string;
}
