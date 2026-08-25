import { IsEmail, IsOptional, IsString, MaxLength } from "class-validator";

export class AuthSignInDTO {
  @IsEmail()
  @IsOptional()
  @MaxLength(254)
  email: string;

  @IsString()
  @IsOptional()
  @MaxLength(32)
  username: string;

  @IsString()
  @MaxLength(1024)
  password: string;

  @IsString()
  @IsOptional()
  @MaxLength(16_384)
  captchaToken?: string;
}
