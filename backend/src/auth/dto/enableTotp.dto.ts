import { IsOptional, IsString, MaxLength } from "class-validator";

export class EnableTotpDTO {
  // Absent for an account without a password that just signed in again with
  // its linked OAuth provider (proof in the reauth_confirmation cookie).
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  password?: string;
}
