import User from "./user.type";

export type Share = {
  uploadPending?: boolean;
  id: string;
  name?: string;
  files: any;
  creator?: User;
  description?: string;
  expiration: Date;
  createdAt?: Date;
  size: number;
  hasPassword: boolean;
  isE2EEncrypted: boolean;
  /** NULL or absent: LEGACY_ACCOUNT_KEY. 2: SHARE_DEK_V1. */
  cryptoScheme?: number | null;
  /** NULL or absent: file names in clear. 1: FILE_META_V1 (encrypted). */
  fileMetadataScheme?: number | null;
  /** FILE_META_V1 only: title and description, encrypted with the share key. */
  encryptedInfo?: string | null;
  previewEnabled?: boolean;
  encryptedReverseShareKey?: string | null;
  reverseShare?: { id: string; creatorId: string } | null;
  teamFolderId?: string | null;
  teamId?: string | null;
};

export type ReverseShare = {
  id: string;
  name?: string;
  /** Name encrypted with K_rs, opened with the key of the link. */
  encryptedName?: string | null;
  maxShareSize: string;
  /** min(creator configured limit, RS maxShareSize) -- computed by the API */
  effectiveMaxShareSize?: string;
  shareExpiration: Date;
  token: string;
  simplified: boolean;
  isE2EEncrypted: boolean;
  /** Uploads encrypt their file names and title with K_rs (FILE_META_V1). */
  fileMetaV1Write?: boolean;
};

export type CompletedShare = Share & {
  /**
   * undefined means is not reverse share
   * true means server was send email to reverse share creator
   * false means server was not send email to reverse share creator
   * */
  notifyReverseShareCreator: boolean | undefined;
};

export type CreateShare = {
  teamFileRequestId?: string;
  id: string;
  name?: string;
  description?: string;
  recipients: string[];
  expiration: string;
  security: ShareSecurity;
  isE2EEncrypted?: boolean;
  cryptoScheme?: number;
  /** SHARE_DEK_V1: K_share wrapped by K_master, never K_share itself. */
  wrappedShareKey?: string;
  wrappedShareKeyAlgorithm?: string;
  /** FILE_META_V1: every file name is encrypted with the content key. */
  fileMetadataScheme?: number;
  /** FILE_META_V1 only: title and description, sent instead of the readable ones. */
  encryptedInfo?: string;
  shareE2EKeyViaEmail?: boolean;
  captchaToken?: string;
  senderName?: string;
  senderEmail?: string;
  notifyOnDownload?: boolean;
  teamFolderId?: string;
};

export type CreateReverseShare = {
  name?: string;
  shareExpiration: string;
  maxShareSize: string;
  maxUseCount: number;
  sendEmailNotification: boolean;
  simplified: boolean;
  publicAccess: boolean;
  encryptedReverseShareKey?: string;
  /** Name encrypted with K_rs, sent instead of `name`. */
  encryptedName?: string;
};

export type ShareMetaData = {
  id: string;
  isZipReady: boolean;
  isE2EEncrypted: boolean;
};

export type MyShare = Omit<Share, "hasPassword"> & {
  views: number;
  createdAt: Date;
  security: MyShareSecurity;
  wrappedShareKey?: string | null;
  wrappedShareKeyAlgorithm?: string | null;
  wrappedShareKeyVersion?: number | null;
};

/** Owner-side key material returned by GET /shares/:id/e2e-key. */
export type ShareKeyMaterial = {
  encryptedReverseShareKey: string | null;
  cryptoScheme?: number | null;
  wrappedShareKey?: string | null;
  wrappedShareKeyAlgorithm?: string | null;
  wrappedShareKeyVersion?: number | null;
};

export type AdminShare = {
  /** Opaque audit reference; never a public share URL identifier. */
  reference: string;
  creator?: { username: string };
  views: number;
  createdAt: Date;
  expiration: Date;
  size: number;
  fileCount: number;
  isE2EEncrypted: boolean;
  status: "READY" | "UNFINISHED" | "INACTIVE" | "UPLOADING";
};

export type MyReverseShare = {
  id: string;
  name?: string;
  /** Name encrypted with K_rs, opened once K_rs is unwrapped. */
  encryptedName?: string | null;
  maxShareSize: string;
  shareExpiration: Date;
  remainingUses: number;
  publicAccess: boolean;
  token: string;
  shares: MyShare[];
  encryptedReverseShareKey?: string;
};

export type ShareSecurity = {
  maxViews?: number;
  password?: string;
};

export type MyShareSecurity = {
  passwordProtected: boolean;
  maxViews: number;
};

export type PendingUpload = {
  id: string;
  createdAt: Date;
  expiration: Date;
  teamFolderId?: string | null;
  canResume: boolean;
  fileCount: number;
  size: number;
};
