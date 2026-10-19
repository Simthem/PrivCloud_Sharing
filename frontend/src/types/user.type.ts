type User = {
  id: string;
  username: string;
  email: string;
  isAdmin: boolean;
  isLdap: boolean;
  totpVerified: boolean;
  hasPassword: boolean;
  hasEncryptionKey: boolean;
  /** True after the user explicitly deletes their E2E key. */
  e2eAutoGenerationDisabled?: boolean;
  notificationMode: string;
  createdAt?: string;
  emailVerificationRequired: boolean;
  emailVerified: boolean;
  emailVerificationBlockedAt: string | null;
  emailVerificationDeletionAt: string | null;
  /** When the address was proven, and how: EMAIL_LINK or ADMINISTRATOR. */
  emailVerifiedAt?: string | null;
  emailVerificationSource?: string | null;
  hasTeamMembership?: boolean;
  hasExternalAccess?: boolean;
  teamId?: string | null;
  /** New personal E2E shares use SHARE_DEK_V1 (server-side rollout flag). */
  shareDekV1Write?: boolean;
  /** Those shares also encrypt their file names (FILE_META_V1). */
  fileMetaV1Write?: boolean;
  /** E2E Team uploads also encrypt their file names with K_team. */
  fileMetaV1TeamWrite?: boolean;
  /** New E2E upload links encrypt their name with K_rs. */
  fileMetaV1ReverseShareWrite?: boolean;
};

export type CreateUser = {
  username: string;
  email: string;
  password?: string;
  isAdmin?: boolean;
};

export type UpdateUser = {
  username?: string;
  email?: string;
  password?: string;
  isAdmin?: boolean;
};

export type UpdateCurrentUser = {
  username?: string;
  email?: string;
  notificationMode?: string;
};

export type CurrentUser = User & {};

export type UserHook = {
  user: CurrentUser | null;
  refreshUser: (
    _options?: { refresh?: boolean },
  ) => Promise<CurrentUser | null>;
};

export default User;
