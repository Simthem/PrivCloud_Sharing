import User from "./user.type";

export type Share = {
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
  previewEnabled?: boolean;
  encryptedReverseShareKey?: string | null;
  reverseShare?: { id: string; creatorId: string } | null;
  teamFolderId?: string | null;
  teamId?: string | null;
};

export type ReverseShare = {
  id: string;
  name?: string;
  maxShareSize: string;
  /** min(creator configured limit, RS maxShareSize) -- computed by the API */
  effectiveMaxShareSize?: string;
  shareExpiration: Date;
  token: string;
  simplified: boolean;
  isE2EEncrypted: boolean;
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
  /** FILE_META_V1: every file name is encrypted with K_share. */
  fileMetadataScheme?: number;
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
  status: "READY" | "UPLOADING";
};

export type MyReverseShare = {
  id: string;
  name?: string;
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
