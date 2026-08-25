import { IsEmail, IsOptional, IsString, MaxLength } from "class-validator";

export class ResetPasswordRequestDTO {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(16_384)
  captchaToken?: string;
}
