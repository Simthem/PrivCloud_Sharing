import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ArrayMaxSize,
  ArrayMinSize,
  MinLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export enum SignatureLevel {
  STANDARD = "STANDARD",
  REINFORCED = "REINFORCED",
}

export class SignatureRecipientDTO {
  @IsEmail()
  @MaxLength(320)
  email: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsIn(["SIGNER", "APPROVER", "CC"])
  role?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  @Type(() => Number)
  order?: number;

  // Client-generated UUIDs let the client encrypt an invitation containing
  // the exact signing URL before the request is persisted.
  @IsOptional()
  @IsUUID()
  signingToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50000)
  teamInviteNotification?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50000)
  teamProgressNotification?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50000)
  teamCompletionNotification?: string;
}

export class SignatureFieldDTO {
  @IsIn(["SIGNATURE", "INITIALS", "DATE", "TEXT", "APPROVAL"])
  type: string;

  @IsInt()
  @Min(0)
  @Max(9999)
  @Type(() => Number)
  page: number;

  @IsNumber()
  @Min(0)
  @Max(10000)
  @Type(() => Number)
  posX: number;

  @IsNumber()
  @Min(0)
  @Max(10000)
  @Type(() => Number)
  posY: number;

  @IsNumber()
  @Min(1)
  @Max(10000)
  @Type(() => Number)
  width: number;

  @IsNumber()
  @Min(1)
  @Max(10000)
  @Type(() => Number)
  height: number;

  @IsOptional()
  @IsNumber()
  @Min(-360)
  @Max(360)
  @Type(() => Number)
  rotation?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  label?: string;

  @IsBoolean()
  @IsOptional()
  required?: boolean;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  assignedRecipientEmail?: string;
}

export class CreateSignatureRequestDTO {
  @IsOptional()
  @IsUUID()
  id?: string;
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]+$/)
  @Length(3, 50)
  shareId: string;

  @IsString()
  @IsUUID()
  fileId: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;

  @IsEnum(SignatureLevel)
  @IsOptional()
  signatureLevel?: SignatureLevel;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsBoolean()
  @IsOptional()
  addApprovalField?: boolean;

  @IsBoolean()
  @IsOptional()
  addApprovalMention?: boolean;

  @IsBoolean()
  @IsOptional()
  addInitials?: boolean;

  @IsOptional()
  @IsIn(["BOTTOM_LEFT", "BOTTOM_CENTER_RIGHT", "BOTTOM_RIGHT"])
  initialsPlacement?: string;

  @IsBoolean()
  @IsOptional()
  initialsIncludeSignaturePage?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9999)
  @Type(() => Number)
  signaturePage?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9999)
  @Type(() => Number)
  watermarkPage?: number;

  @IsBoolean()
  @IsOptional()
  isE2EEncrypted?: boolean;

  @IsBoolean()
  @IsOptional()
  sendE2EKeyByEmail?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/)
  @Length(16, 4096)
  e2eKey?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SignatureRecipientDTO)
  recipients: SignatureRecipientDTO[];

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SignatureFieldDTO)
  @IsOptional()
  fields?: SignatureFieldDTO[];

  @IsOptional()
  @IsString()
  @IsUUID()
  teamId?: string;
}
