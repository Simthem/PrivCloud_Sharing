import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Matches,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class CreateTeamDTO {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}

export class UpdateTeamDTO {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsString()
  @IsIn(["DAILY", "WEEKLY", "MONTHLY"])
  reportFrequency?: string;

  @IsOptional()
  @IsBoolean()
  reportEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  pqNotificationEncryptionEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([30, 60, 90, 180, 365])
  keyRotationIntervalDays?: number;
}

export class StartTeamKeyRotationDTO {
  @IsString()
  @MaxLength(8192)
  @Matches(/^[A-Za-z0-9_-]+$/)
  newWrappedTeamKey: string;

  @IsOptional()
  @IsIn(["MANUAL", "POLICY"])
  reason?: string;
}

export class UpdateTeamKeyRotationProgressDTO {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  completedFileId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  failedFiles?: number;

  @IsOptional()
  @IsIn(["REENCRYPTING", "PAUSED"])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  errorMessage?: string;
}

export class InviteMemberDTO {
  @IsEmail({}, { message: "A valid email address is required" })
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsString()
  @IsIn(["ADMIN", "MEMBER"])
  role?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  @Matches(/^[A-Za-z0-9_-]+$/)
  encryptedTeamKey?: string;
}

export class UpdateMemberRoleDTO {
  @IsString()
  @IsIn(["ADMIN", "MEMBER"])
  role: string;
}

export class CreateFolderDTO {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  parentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;
}

export class SetFolderAccessDTO {
  @IsString()
  @MaxLength(128)
  memberId: string;

  @IsIn(["NONE", "READ", "WRITE", "ADMIN"])
  permission: string;

  @IsOptional()
  @IsBoolean()
  canRequestSignature?: boolean;

  @IsOptional()
  @IsBoolean()
  canShareE2E?: boolean;
}

export class SetFileAccessDTO {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  fileIds: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SetFileAccessMemberDTO)
  members: SetFileAccessMemberDTO[];
}

export class SetFileAccessMemberDTO {
  @IsString()
  @MaxLength(128)
  memberId: string;

  @IsIn(["NONE", "READ", "WRITE", "ADMIN", "DENY"])
  permission: string;

  @IsOptional()
  @IsBoolean()
  canRequestSignature?: boolean;

  @IsOptional()
  @IsBoolean()
  canShareE2E?: boolean;
}

export class BulkDeleteFileItemDTO {
  @IsString()
  @MaxLength(128)
  shareId: string;

  @IsString()
  @MaxLength(128)
  fileId: string;
}

export class BulkDeleteFilesDTO {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BulkDeleteFileItemDTO)
  files: BulkDeleteFileItemDTO[];
}

export class AdminCreateTeamDTO {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name: string;

  @IsString()
  @MinLength(2)
  @MaxLength(30)
  slug: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsEmail({}, { message: "A valid owner email is required" })
  @MaxLength(254)
  ownerEmail: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxMembers?: number;
}

export class AdminAddMemberDTO {
  @IsString()
  userId: string;

  @IsOptional()
  @IsString()
  role?: string;
}

export class AdminSetRoleDTO {
  @IsString()
  role: string;
}

export class AdminSetMaxMembersDTO {
  @IsInt()
  @Min(1)
  maxMembers: number;
}

export class CreateGuestLinkDTO {
  @IsString()
  @MaxLength(128)
  folderId: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsString()
  @IsIn(["READ", "WRITE"])
  permission?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(8760)
  expiresInHours?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10000)
  maxDownloads?: number;

  @IsOptional()
  @IsBoolean()
  requiresPassword?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;
}
