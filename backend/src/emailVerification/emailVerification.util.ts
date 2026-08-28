import { ForbiddenException } from "@nestjs/common";

export const EMAIL_VERIFICATION_GRACE_DAYS = 5;
export const EMAIL_VERIFICATION_DELETION_DAYS = 14;
export const EMAIL_VERIFICATION_TOKEN_TTL_HOURS = 24;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EmailVerificationUser {
  emailVerificationRequiredAt?: Date | null;
  emailVerifiedAt?: Date | null;
  emailVerificationDeletionStartedAt?: Date | null;
}

export interface EmailVerificationState {
  required: boolean;
  verified: boolean;
  blocked: boolean;
  deletionStarted: boolean;
  blockedAt: Date | null;
  deletionAt: Date | null;
}

export function getEmailVerificationState(
  user: EmailVerificationUser,
  now = new Date(),
): EmailVerificationState {
  const requiredAt = user.emailVerificationRequiredAt;

  // This is the migration invariant: NULL means a permanent exemption for
  // every account that existed before this feature. Never infer eligibility
  // from emailVerifiedAt alone.
  if (!requiredAt) {
    return {
      required: false,
      verified: true,
      blocked: false,
      deletionStarted: false,
      blockedAt: null,
      deletionAt: null,
    };
  }

  const blockedAt = new Date(
    requiredAt.getTime() + EMAIL_VERIFICATION_GRACE_DAYS * DAY_MS,
  );
  const deletionAt = new Date(
    requiredAt.getTime() + EMAIL_VERIFICATION_DELETION_DAYS * DAY_MS,
  );
  const verified = !!user.emailVerifiedAt;
  const deletionStarted = !!user.emailVerificationDeletionStartedAt;

  return {
    required: true,
    verified,
    blocked: !verified && (deletionStarted || now >= blockedAt),
    deletionStarted,
    blockedAt,
    deletionAt,
  };
}

export function assertEmailVerificationAccess(
  user: EmailVerificationUser,
  now = new Date(),
): void {
  const state = getEmailVerificationState(user, now);
  if (!state.blocked) return;

  throw new ForbiddenException({
    statusCode: 403,
    error: "email_verification_required",
    message:
      "Verify your email address to regain access to this account before it is deleted.",
    blockedAt: state.blockedAt?.toISOString(),
    deletionAt: state.deletionAt?.toISOString(),
  });
}

