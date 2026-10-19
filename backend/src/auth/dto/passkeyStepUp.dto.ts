import { IsOptional, IsString, MaxLength } from "class-validator";

/** Proof required before a passkey is added to the account. */
export class PasskeyStepUpDTO {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;
}
