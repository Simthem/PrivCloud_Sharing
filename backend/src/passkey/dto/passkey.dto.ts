import { IsObject, IsUUID } from "class-validator";

/** WebAuthn ceremony answer, checked by @simplewebauthn/server. */
export class PasskeyResponseDTO {
  @IsUUID()
  challengeId: string;

  @IsObject()
  response: Record<string, unknown>;
}
