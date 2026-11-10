import { PartialType, PickType } from "@nestjs/swagger";
import { IsBoolean, ValidateIf } from "class-validator";
import { UserDTO } from "./user.dto";

export class UpdateOwnUserDTO extends PartialType(
  PickType(UserDTO, ["username", "email", "notificationMode"] as const),
) {
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  signaturePushEnabled?: boolean;
}
