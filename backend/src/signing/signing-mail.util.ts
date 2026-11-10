import {
  SigningLanguage,
  signingDateTime,
  signingMails,
} from "./signing-language";

export interface SigningCompletionRecipient {
  email: string;
  name: string;
  role: string;
  userId?: string | null;
  signedAt?: Date | null;
}

interface SigningCompletionMailOptions {
  fileName: string;
  language: SigningLanguage;
  documentUrl: string;
  teamId?: string | null;
  creator?: {
    email: string;
    username?: string | null;
  } | null;
  recipients: SigningCompletionRecipient[];
  sendMail: (email: string, subject: string, body: string) => Promise<void>;
  onFailure?: (email: string, error: unknown) => void;
}

/**
 * Completion notifications must never roll back a successfully finalized PDF.
 * The creator is attempted first, then every recipient independently.
 */
export async function deliverSigningCompletionEmails(
  options: SigningCompletionMailOptions,
): Promise<{ sent: number; failed: number }> {
  const mail = signingMails(options.language);
  const signersList = options.recipients
    .filter((recipient) => recipient.role === "SIGNER")
    .map((recipient) =>
      mail.signerLine(
        `${recipient.name} (${recipient.email})`,
        recipient.signedAt
          ? signingDateTime(
              new Date(recipient.signedAt),
              options.language,
              "short",
            )
          : "N/A",
      ),
    )
    .join("\n");

  let sent = 0;
  let failed = 0;
  const attempt = async (email: string, subject: string, body: string) => {
    try {
      await options.sendMail(email, subject, body);
      sent++;
    } catch (error) {
      failed++;
      try {
        options.onFailure?.(email, error);
      } catch {
        // Notification diagnostics must remain best-effort too.
      }
    }
  };

  if (options.creator?.email) {
    await attempt(
      options.creator.email,
      mail.completedCreatorSubject(options.fileName),
      mail.hello(options.creator.username || "") +
        mail.completedCreatorBody({
          file: options.fileName,
          signers: signersList,
          url: options.documentUrl,
          team: Boolean(options.teamId),
        }) +
        mail.footer,
    );
  }

  await Promise.all(
    options.recipients.map((recipient) =>
      attempt(
        recipient.email,
        mail.completedSubject(options.fileName),
        mail.hello(recipient.name) +
          mail.completedBody({
            file: options.fileName,
            signers: signersList,
            url: options.documentUrl,
            account: Boolean(recipient.userId),
          }) +
          mail.footer,
      ),
    ),
  );

  return { sent, failed };
}
