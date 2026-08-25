import { IsString, MaxLength } from "class-validator";

export class AuthSignInTotpDTO {
  @IsString()
  @MaxLength(64)
  totp: string;

  @IsString()
  @MaxLength(256)
  loginToken: string;
}
