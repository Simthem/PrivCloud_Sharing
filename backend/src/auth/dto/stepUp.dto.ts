import { Type } from "class-transformer";
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { PasskeyResponseDTO } from "src/passkey/dto/passkey.dto";

export class StepUpScopeDTO {
  // The operation and its target, as named by the refusal that asked for it.
  @IsString()
  @Matches(/^[a-z][a-z.]{2,48}(?::[A-Za-z0-9_-]{1,64})?$/)
  scope: string;
}

/**
 * The password (local or directory) or a fresh linked sign-in, with the
 * current code when 2FA is on. Or else an account passkey.
 */
export class StepUpDTO extends StepUpScopeDTO {
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PasskeyResponseDTO)
  passkey?: PasskeyResponseDTO;
}
