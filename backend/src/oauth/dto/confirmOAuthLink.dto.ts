import { IsString, MaxLength } from "class-validator";

export class ConfirmOAuthLinkDTO {
  @IsString()
  @MaxLength(4096)
  token: string;
}
