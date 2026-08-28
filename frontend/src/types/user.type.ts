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
  hasTeamMembership?: boolean;
  teamId?: string | null;
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
