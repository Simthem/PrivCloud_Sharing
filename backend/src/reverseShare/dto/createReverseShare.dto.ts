import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from "class-validator";

export class CreateReverseShareDTO {
  @Length(3, 90)
  @IsOptional()
  name: string;

  @IsBoolean()
  sendEmailNotification: boolean;

  @IsString()
  maxShareSize: string;

  @IsString()
  shareExpiration: string;

  @Min(1)
  @Max(1000)
  maxUseCount: number;

  @IsBoolean()
  simplified: boolean;

  @IsBoolean()
  publicAccess: boolean;

   // E2E: K_rs encrypted by the owner's master key (base64url)
  @IsOptional()
  @IsString()
  encryptedReverseShareKey?: string;
}
