import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";
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
