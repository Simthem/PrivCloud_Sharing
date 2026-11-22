import { Prisma } from "@prisma/client";

type Client = Pick<
  Prisma.TransactionClient,
  | "refreshToken"
  | "loginToken"
  | "stepUpGrant"
  | "evidenceVaultSession"
  | "oAuthReauthToken"
>;

/**
 * Identity confirmations and evidence vault unlocks end with the sign-in
 * they were made in, and with every session when a credential changes.
 */
export async function revokeConfirmations(
  client: Omit<Client, "refreshToken" | "loginToken">,
  userId: string,
) {
  await client.stepUpGrant.deleteMany({ where: { userId } });
  await client.evidenceVaultSession.deleteMany({ where: { userId } });
  await client.oAuthReauthToken.deleteMany({ where: { userId } });
}

/** Every session of the account, and what they confirmed, ends now. */
export async function revokeSessions(client: Client, userId: string) {
  await client.refreshToken.deleteMany({ where: { userId } });
  await client.loginToken.deleteMany({ where: { userId } });
  await revokeConfirmations(client, userId);
}
