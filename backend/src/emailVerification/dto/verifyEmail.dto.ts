import { IsString, Length } from "class-validator";

export class VerifyEmailDTO {
  @IsString()
  @Length(43, 43)
  token: string;
}

