import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

export class EmailChangeDTO {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;
}

export class EmailChangeTokenDTO {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token: string;
}
