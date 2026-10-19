import { IsString, MaxLength } from "class-validator";

/** The exact name of the deleted team, typed by the administrator. */
export class EraseVaultTeamDTO {
  @IsString()
  @MaxLength(200)
  confirmation: string;
}
