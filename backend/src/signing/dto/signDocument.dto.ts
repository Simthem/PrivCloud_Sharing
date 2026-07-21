import {
  ArrayMaxSize,
  IsIn,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class SignatureFieldValueDTO {
  @IsString()
  @IsUUID()
  fieldId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  value: string;
}

export class SignDocumentDTO {
  @IsString()
  @MinLength(1)
  @MaxLength(5_000_000) // base64 PNG can be large but cap at ~3.75 MB decoded
  signatureData: string; // base64 PNG (drawn/uploaded) or text (typed)

  @IsIn(["DRAW", "TYPE", "UPLOAD"])
  signatureType: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: "OTP must be exactly 6 digits" })
  otpCode?: string; // OTP for AES identity verification

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SignatureFieldValueDTO)
  fieldValues?: SignatureFieldValueDTO[];
}

export class RejectDocumentDTO {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class VerifyOtpDTO {
  @IsString()
  @Matches(/^\d{6}$/, { message: "OTP must be exactly 6 digits" })
  otpCode: string;
}

export class PrepareE2ECertificateDTO {
  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/, {
    message: "documentHash must be a SHA-256 hexadecimal digest",
  })
  documentHash: string;
}

export class SignE2EDigestDTO {
  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/, {
    message: "digest must be a SHA-256 hexadecimal digest",
  })
  digest: string;
}

export class FinalizeE2EDTO {
  @IsString()
  @MinLength(100)
  @MaxLength(200_000_000)
  @Matches(/^[A-Za-z0-9+/\n\r]+=*$/, {
    message: "encryptedPdf must be valid base64",
  })
  encryptedPdf: string;
}
