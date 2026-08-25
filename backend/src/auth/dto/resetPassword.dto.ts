import { PickType } from "@nestjs/swagger";
import { IsString, MaxLength } from "class-validator";
import { UserDTO } from "src/user/dto/user.dto";

export class ResetPasswordDTO extends PickType(UserDTO, ["password"]) {
  @IsString()
  @MaxLength(256)
  token: string;
}
