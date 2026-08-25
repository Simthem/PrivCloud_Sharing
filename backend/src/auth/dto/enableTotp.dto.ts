import { IsString, MaxLength } from "class-validator";

export class EnableTotpDTO {
  @IsString()
  @MaxLength(1024)
  password: string;
}
