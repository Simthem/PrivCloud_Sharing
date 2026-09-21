export interface LoginBackoffPolicy {
  maxFailures: number;
  baseLockMinutes: number;
  maxLockMinutes: number;
  failureWindowMinutes: number;
}

export interface LoginFailureState {
  attempts: number;
  lastFailedLoginAt: Date;
  lockedUntil: Date | null;
  retryAfterSeconds: number;
}

/** Pure calculation shared by password and LDAP failures. */
export function nextLoginFailureState(args: {
  previousAttempts: number;
  lastFailedLoginAt?: Date | null;
  previousLockedUntil?: Date | null;
  now?: Date;
  policy: LoginBackoffPolicy;
}): LoginFailureState {
  const now = args.now ?? new Date();
  const windowMs = args.policy.failureWindowMinutes * 60_000;
  // The quiet window starts once the user was actually allowed to retry. Using
  // only the failure timestamp would make a long mandatory lock reset itself.
  const observationStart = Math.max(
    args.lastFailedLoginAt?.getTime() ?? 0,
    args.previousLockedUntil?.getTime() ?? 0,
  );
  const insideWindow = Boolean(
    observationStart && now.getTime() - observationStart <= windowMs,
  );
  const attempts = (insideWindow ? Math.max(0, args.previousAttempts) : 0) + 1;

  if (attempts < args.policy.maxFailures) {
    return {
      attempts,
      lastFailedLoginAt: now,
      lockedUntil: null,
      retryAfterSeconds: 0,
    };
  }

  const exponent = Math.min(30, attempts - args.policy.maxFailures);
  const lockMinutes = Math.min(
    args.policy.maxLockMinutes,
    args.policy.baseLockMinutes * 2 ** exponent,
  );
  const retryAfterSeconds = Math.max(60, Math.ceil(lockMinutes * 60));
  return {
    attempts,
    lastFailedLoginAt: now,
    lockedUntil: new Date(now.getTime() + retryAfterSeconds * 1000),
    retryAfterSeconds,
  };
}
