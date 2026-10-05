import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  IsBoolean,
  IsIn,
  Matches,
  ValidateIf,
  ValidateNested,
} from "class-validator";

export class FileRequestNotificationDTO {
  @IsUUID()
  userId: string;

  @IsString()
  @MaxLength(20000)
  encryptedMetadata: string;
}

export class CreateTeamFileRequestDTO {
  @IsUUID()
  id: string;

  @IsUUID()
  folderId: string;

  // Empty when encryptedInfo carries the subject, see the service.
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @ValidateIf((o: CreateTeamFileRequestDTO) => o.encryptedInfo === undefined)
  @IsString()
  @Length(3, 120)
  subject: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(2000)
  note?: string;

  // Subject and note encrypted with K_team (base64url).
  @IsOptional()
  @IsString()
  @MaxLength(22000)
  @Matches(/^[A-Za-z0-9_-]+$/)
  encryptedInfo?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  recipientIds: string[];

  @IsIn(["ALL", "SELECTED"])
  recipientScope: "ALL" | "SELECTED";

  @IsOptional()
  @IsBoolean()
  sendEmail?: boolean;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FileRequestNotificationDTO)
  notifications: FileRequestNotificationDTO[];

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  submissionNotification?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  expiresAt?: string;
}
