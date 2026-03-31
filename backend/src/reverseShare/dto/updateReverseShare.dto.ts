import { IsString } from "class-validator";

export class UpdateReverseShareDTO {
  @IsString()
  shareExpiration: string;
}
