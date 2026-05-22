import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

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
  reportFrequency?: string; // DAILY | WEEKLY | MONTHLY
}

export class InviteMemberDTO {
  @IsEmail({}, { message: "A valid email address is required" })
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsString()
  role?: string; // ADMIN | MEMBER

  @IsOptional()
  @IsString()
  encryptedTeamKey?: string; // K_team wrapped for the invitee (base64url)
}

export class UpdateMemberRoleDTO {
  @IsString()
  role: string; // OWNER | ADMIN | MEMBER
}

export class CreateFolderDTO {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsString()
  color?: string;
}

export class SetFolderAccessDTO {
  @IsString()
  memberId: string;

  @IsIn(["NONE", "READ", "WRITE", "ADMIN"])
  permission: string;

  @IsOptional()
  @IsBoolean()
  canRequestSignature?: boolean;
}

export class SetFileAccessDTO {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  fileIds: string[];

  @IsArray()
  @ArrayMinSize(1)
  members: SetFileAccessMemberDTO[];
}

export class SetFileAccessMemberDTO {
  @IsString()
  memberId: string;

  @IsIn(["READ", "WRITE", "ADMIN"])
  permission: string;

  @IsOptional()
  @IsBoolean()
  canRequestSignature?: boolean;
}

export class BulkDeleteFilesDTO {
  @IsArray()
  @ArrayMinSize(1)
  files: { shareId: string; fileId: string }[];
}

export class AddTeamMemberSeatDTO {
  @IsInt()
  @Min(1)
  @Max(50)
  additionalSeats: number; // how many extra members to purchase
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
  folderId: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsString()
  permission?: string; // READ | WRITE (default READ)

  @IsOptional()
  @IsNumber()
  expiresInHours?: number; // null = no expiry

  @IsOptional()
  @IsNumber()
  maxDownloads?: number; // null = unlimited

  @IsOptional()
  @IsBoolean()
  requiresPassword?: boolean;

  @IsOptional()
  @IsString()
  password?: string;
}
