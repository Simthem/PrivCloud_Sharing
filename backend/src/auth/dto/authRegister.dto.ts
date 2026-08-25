import { PickType } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { UserDTO } from "src/user/dto/user.dto";

export class AuthRegisterDTO extends PickType(UserDTO, [
  "email",
  "username",
  "password",
] as const) {
  @IsString()
  @IsOptional()
  @MaxLength(16_384)
  captchaToken?: string;
}
