import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

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

export class SignE2EPdfDTO {
  @IsString()
  @MinLength(100) // a valid PDF in base64 is at minimum a few hundred chars
  @MaxLength(200_000_000) // ~150 MB decoded - generous for large PDFs
  @Matches(/^[A-Za-z0-9+/\n\r]+=*$/, {
    message: "plaintextPdf must be valid base64",
  })
  plaintextPdf: string;
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
