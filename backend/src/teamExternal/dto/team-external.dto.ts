import { Transform } from "class-transformer";
import { PasskeyResponseDTO } from "src/passkey/dto/passkey.dto";
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import {
  EXTERNAL_WRAPPING_ALGORITHM,
  EXTERNAL_MANIFEST_MAX_LENGTH,
  EXTERNAL_PREVIEW_MAX_PAGES,
} from "../team-external.util";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class InviteExternalSeatDTO {
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: "A valid email address is required" })
  @MaxLength(254)
  email: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  displayName?: string;

  @IsDateString()
  accessExpiresAt: string;
}

export class UpdateExternalSeatDTO {
  @IsDateString()
  accessExpiresAt: string;
}

export class ExternalRevocationWatchDTO {
  @IsIn(["NONE", "EMAIL", "PUSH", "BOTH"])
  mode: "NONE" | "EMAIL" | "PUSH" | "BOTH"
}

export class EvidenceDownloadOptionsDTO {
  @IsIn(["certificate", "evidence", "pattern"])
  kind: "certificate" | "evidence" | "pattern"
}

export class CreateExternalPreviewDTO {
  // Chosen by the client: the manifest and every page authenticate it.
  @IsUUID()
  id: string;

  @IsUUID()
  seatId: string;

  @IsUUID()
  sourceFileId: string;

  @IsInt()
  @Min(1)
  @Max(EXTERNAL_PREVIEW_MAX_PAGES)
  pageCount: number;

  @IsString()
  @MaxLength(EXTERNAL_MANIFEST_MAX_LENGTH)
  @Matches(/^[A-Za-z0-9_-]+$/)
  encryptedManifest: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/)
  encryptedKey: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/)
  ephemeralPublicKey: string;

  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  nonce: string;

  @IsString()
  @MaxLength(2048)
  @Matches(/^[A-Za-z0-9_-]+$/)
  kemCiphertext: string;

  @IsIn([EXTERNAL_WRAPPING_ALGORITHM])
  algorithm: string;
}

export class ApproveIssuanceDTO extends PasskeyResponseDTO {
  // Title of the document under the team audit key, for the register list.
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  @Matches(/^[A-Za-z0-9_-]+$/)
  encryptedLabel?: string;
}

/**
 * What only the administrator's browser can compute about a copy. The
 * register entry adds everything the server knows itself.
 */
export class PrepareIssuanceDTO {
  @IsOptional()
  @Matches(/^privcloud:forensic-multiscale:v2$/)
  robustMarkAlgorithm?: "privcloud:forensic-multiscale:v2"

  @IsOptional()
  @Matches(/^privcloud:visible-copy:v1$/)
  visibleMarkAlgorithm?: "privcloud:visible-copy:v1"

  @Matches(/^[a-f0-9]{32}$/)
  markId: string;

  @Matches(/^[a-f0-9]{64}$/)
  sourceSha256: string;

  // Each page: plainSha256, cipherSha256, width and height, checked by
  // isValidIssuanceInput.
  @IsArray()
  @ArrayMaxSize(EXTERNAL_PREVIEW_MAX_PAGES)
  pages: unknown[];
}

export class SetTeamAuditKeyDTO {
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/)
  encryptedKey: string;

  @IsInt()
  @Min(1)
  keyVersion: number;
}
