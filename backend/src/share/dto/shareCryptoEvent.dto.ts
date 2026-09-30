import { IsIn, IsOptional, IsString, Matches } from "class-validator";
import {
  SHARE_CRYPTO_CLIENTS,
  SHARE_CRYPTO_EVENTS,
  ShareCryptoClient,
  ShareCryptoEvent,
} from "../share-crypto-scheme";

/**
 * Anonymous client-side crypto outcome. Carries no share id, no user id and
 * no key material: only what is needed to count failures per scheme and per
 * client version.
 */
export class ShareCryptoEventDTO {
  @IsIn([...SHARE_CRYPTO_EVENTS])
  event: ShareCryptoEvent;

  @IsIn(["LEGACY_ACCOUNT_KEY", "SHARE_DEK_V1"])
  scheme: string;

  @IsIn([...SHARE_CRYPTO_CLIENTS])
  client: ShareCryptoClient;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9A-Za-z.+-]{1,32}$/)
  clientVersion?: string;
}
