import { IsString, MaxLength } from "class-validator";
import { EnableTotpDTO } from "./enableTotp.dto";

export class VerifyTotpDTO extends EnableTotpDTO {
  @IsString()
  @MaxLength(64)
  code: string;
}
