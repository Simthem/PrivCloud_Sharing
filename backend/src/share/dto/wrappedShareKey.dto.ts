import { IsInt, IsString, Matches, Min } from "class-validator";
import { WRAPPED_SHARE_KEY_PATTERN } from "../share-crypto-scheme";

/** Rewrap of K_share under a new K_master, sent after a key rotation. */
export class UpdateWrappedShareKeyDTO {
  @IsString()
  @Matches(WRAPPED_SHARE_KEY_PATTERN, {
    message: "wrappedShareKey must be a 60-byte base64url value",
  })
  wrappedShareKey: string;

  // Version the client unwrapped. The update is refused if another tab or
  // device rewrapped the key in the meantime.
  @IsInt()
  @Min(1)
  expectedVersion: number;
}
