export interface SigningCompletionRecipient {
  email: string;
  name: string;
  role: string;
  userId?: string | null;
  signedAt?: Date | null;
}

interface SigningCompletionMailOptions {
  fileName: string;
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
  const signersList = options.recipients
    .filter((recipient) => recipient.role === "SIGNER")
    .map(
      (recipient) =>
        `  - ${recipient.name} (${recipient.email}) - signé le ${
          recipient.signedAt
            ? new Date(recipient.signedAt).toLocaleString("fr-FR", {
                dateStyle: "long",
                timeStyle: "short",
                timeZone: "Europe/Paris",
              })
            : "N/A"
        }`,
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
      `Document signé par tous les signataires - ${options.fileName}`,
      `Bonjour ${options.creator.username || ""},\n\n` +
        `Le document "${options.fileName}" a été signé par l'ensemble des signataires et finalisé avec succès.\n\n` +
        `Signataires :\n${signersList}\n\n` +
        `La signature cryptographique PAdES a été appliquée.\n\n` +
        `Consultez et téléchargez le document signé ici :\n${options.documentUrl}\n\n` +
        (options.teamId
          ? `Ce document est également visible dans l'espace de votre équipe.\n\n`
          : "") +
        `-- \nPrivCloud Sharing - Signature Électronique`,
    );
  }

  await Promise.all(
    options.recipients.map((recipient) =>
      attempt(
        recipient.email,
        `Document signé - ${options.fileName}`,
        `Bonjour ${recipient.name},\n\n` +
          `Le document "${options.fileName}" a été signé par tous les signataires et la signature cryptographique PAdES a été appliquée.\n\n` +
          `Signataires :\n${signersList}\n\n` +
          (recipient.userId
            ? `Vous pouvez consulter et télécharger le document signé depuis votre espace :\n${options.documentUrl}\n\n` +
              `Ce document apparaît également dans votre rubrique "Documents reçus" de l'onglet Signature.\n\n`
            : `Si vous avez un compte PrivCloud Sharing, connectez-vous pour retrouver ce document dans vos "Documents reçus".\n\n`) +
          `-- \nPrivCloud Sharing - Signature Électronique`,
      ),
    ),
  );

  return { sent, failed };
}
