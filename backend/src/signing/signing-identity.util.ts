import { verifiedEmailFold } from "src/config/account-secrets";
import type { PrismaService } from "src/prisma/prisma.service";

export type SigningIdentityAccount = {
  emailVerifiedAt: Date | null;
  emailVerificationSource: string | null;
  ldapDN: string | null;
  oAuthUsers?: { provider: string }[];
};

export type SigningIdentityProof = {
  method:
    | "VERIFIED_EMAIL_ACCOUNT"
    | "ADMIN_VERIFIED_EMAIL_ACCOUNT"
    | "LDAP_ACCOUNT"
    | "OIDC_ACCOUNT";
  verifiedAt: Date;
};

/**
 * Resolve the account-level identity proof PrivCloud can honestly evidence
 * without claiming a state-issued or qualified civil identity.
 */
export function resolveSigningIdentityProof(
  user: SigningIdentityAccount,
  now = new Date(),
): SigningIdentityProof | null {
  if (user.ldapDN) {
    return { method: "LDAP_ACCOUNT", verifiedAt: now };
  }
  if (user.oAuthUsers?.length) {
    return { method: "OIDC_ACCOUNT", verifiedAt: now };
  }
  // An automatic exemption (no SMTP, bootstrap) also sets emailVerifiedAt
  // but proves nothing, so only a recorded source counts.
  if (user.emailVerifiedAt && user.emailVerificationSource === "EMAIL_LINK") {
    return {
      method: "VERIFIED_EMAIL_ACCOUNT",
      verifiedAt: user.emailVerifiedAt,
    };
  }
  if (
    user.emailVerifiedAt &&
    user.emailVerificationSource === "ADMINISTRATOR"
  ) {
    return {
      method: "ADMIN_VERIFIED_EMAIL_ACCOUNT",
      verifiedAt: user.emailVerifiedAt,
    };
  }
  return null;
}

type ProofClient = {
  user: Pick<PrismaService["user"], "findUnique">;
  oAuthUser: Pick<PrismaService["oAuthUser"], "findMany">;
};

/**
 * The address of an account when it proved it owns it: mailed link,
 * administrator, directory or a provider vouching for it. An address set
 * verified automatically (no SMTP, bootstrap) proves nothing.
 */
export async function provenAccountEmail(
  prisma: ProofClient,
  userId: string,
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      emailVerifiedAt: true,
      emailVerificationSource: true,
      ldapDN: true,
    },
  });
  if (!user?.email) return null;
  if (
    user.ldapDN ||
    (user.emailVerifiedAt &&
      ["EMAIL_LINK", "ADMINISTRATOR"].includes(
        user.emailVerificationSource ?? "",
      ))
  ) {
    return user.email;
  }
  const links = await prisma.oAuthUser.findMany({
    where: { userId, verifiedEmailFold: verifiedEmailFold(user.email) },
    select: { userId: true, verifiedEmail: true },
  });
  return links.some(
    (link) => link.verifiedEmail?.toLowerCase() === user.email.toLowerCase(),
  )
    ? user.email
    : null;
}
