import { plainToClass } from "class-transformer";
import { Allow, IsIn, IsOptional, MinLength } from "class-validator";
import { UserDTO } from "./user.dto";

export class CreateUserDTO extends UserDTO {
  @Allow()
  isAdmin: boolean;

  @MinLength(8)
  @IsOptional()
  password: string;

  @IsOptional()
  @IsIn(["FREE", "STARTER", "PRO", "TEAM"])
  plan?: string;

  from(partial: Partial<CreateUserDTO>) {
    return plainToClass(CreateUserDTO, partial, {
      excludeExtraneousValues: true,
    });
  }
}
