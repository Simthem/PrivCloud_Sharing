import { IsEmail, MaxLength } from "class-validator";

export class ResendEmailVerificationDTO {
  @IsEmail()
  @MaxLength(254)
  email: string;
}

