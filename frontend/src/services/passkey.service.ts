import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import api from "./api.service";
import { apiPathSegment } from "../utils/apiPath.util";

export type AccountPasskey = {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string;
  backedUp: boolean;
};

type Ceremony = { challengeId: string; options: Record<string, unknown> };

/** Passkeys added from the account, and how many signing ones it has. */
const list = async (): Promise<{
  passkeys: AccountPasskey[];
  signingPasskeys: number;
}> => (await api.get("passkeys")).data;

/**
 * Creates a passkey on this device, for sign-in and approvals. The server
 * first asks for the same proof as turning 2FA off: the password (or the
 * fresh linked sign-in cookie) and the current code when 2FA is on.
 */
const register = async (
  stepUp: { password?: string; code?: string } = {},
): Promise<AccountPasskey> => {
  const ceremony: Ceremony = (
    await api.post("auth/passkey/registration", stepUp)
  ).data;
  const response = await startRegistration({
    optionsJSON: ceremony.options as unknown as Parameters<
      typeof startRegistration
    >[0]["optionsJSON"],
  });
  return (
    await api.post("auth/passkey/registration/verify", {
      challengeId: ceremony.challengeId,
      response,
    })
  ).data;
};

const remove = async (passkeyId: string): Promise<void> => {
  await api.delete(`passkeys/${apiPathSegment(passkeyId)}`);
};

/**
 * Sign-in without an address: the browser offers the passkeys it holds for
 * this site. Session cookies are set exactly as after a password sign-in.
 */
const signIn = async () => {
  const ceremony: Ceremony = (await api.post("auth/passkey/options")).data;
  const response = await startAuthentication({
    optionsJSON: ceremony.options as unknown as Parameters<
      typeof startAuthentication
    >[0]["optionsJSON"],
  });
  return api.post("auth/passkey", {
    challengeId: ceremony.challengeId,
    response,
  });
};

const passkeyService = { list, register, remove, signIn };

export default passkeyService;
