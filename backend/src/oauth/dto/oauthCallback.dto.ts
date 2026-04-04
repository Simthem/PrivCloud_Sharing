import { IsOptional, IsString } from "class-validator";

export class OAuthCallbackDto {
  @IsString()
  code: string;

  @IsString()
  state: string;

  // Populated by the controller from the state cookie -- not from the query string.
  @IsOptional()
  nonce?: string;
}
