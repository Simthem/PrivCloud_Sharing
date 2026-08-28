import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { User } from "@prisma/client";
import moment from "moment";
import * as nodemailer from "nodemailer";
import { ConfigService } from "src/config/config.service";

export function buildEmailVerificationMessage(
  appName: string,
  verificationUrl: string,
): string {
  return [
    `Welcome to ${appName}.`,
    "",
    "Verify your email address using this secure link:",
    verificationUrl,
    "",
    "The link expires in 24 hours. You can request a new one without extending the account deadline.",
    "Access is blocked after 5 days without verification and the account is deleted after 14 days.",
    "",
    "Bienvenue. Vérifiez votre adresse e-mail avec le lien ci-dessus.",
    "Sans validation, l’accès sera bloqué après 5 jours et le compte supprimé après 14 jours.",
  ].join("\n");
}

@Injectable()
export class EmailService {
  constructor(private config: ConfigService) {}
  private readonly logger = new Logger(EmailService.name);

  getTransporter() {
    if (!this.config.get("smtp.enabled"))
      throw new InternalServerErrorException("SMTP is disabled");

    const username = this.config.get("smtp.username");
    const password = this.config.get("smtp.password");

    return nodemailer.createTransport({
      host: this.config.get("smtp.host"),
      port: this.config.get("smtp.port"),
      secure: this.config.get("smtp.port") == 465,
      auth:
        username || password ? { user: username, pass: password } : undefined,
      tls: {
        rejectUnauthorized: !this.config.get(
          "smtp.allowUnauthorizedCertificates",
        ),
      },
    });
  }

  async sendMail(email: string, subject: string, text: string) {
    const replyTo = this.config.get("email.replyToEmail")?.trim() || undefined;
    const senderName =
      this.config.get("email.senderName")?.trim() ||
      this.config.get("general.appName");
    await this.getTransporter()
      .sendMail({
        from: `"${senderName}" <${this.config.get("smtp.email")}>`,
        replyTo,
        to: email,
        subject,
        text,
      })
      .catch((e) => {
        this.logger.error(e);
        throw new InternalServerErrorException("Failed to send email");
      });
  }

  async sendMailToShareRecipients(
    recipientEmail: string,
    shareId: string,
    creator?: User,
    shareName?: string,
    description?: string,
    expiration?: Date,
    e2eKeyFragment?: string,
  ) {
    if (!this.config.get("email.enableShareEmailRecipients"))
      throw new InternalServerErrorException("Email service disabled");

    const baseUrl = `${this.config.get("general.appUrl")}/s/${shareId}`;
    const shareUrl = e2eKeyFragment ? `${baseUrl}#key=${e2eKeyFragment}` : baseUrl;

    await this.sendMail(
      recipientEmail,
      this.config.get("email.shareRecipientsSubject"),
      this.config
        .get("email.shareRecipientsMessage")
        .replaceAll("\\n", "\n")
        .replaceAll("{creator}", creator?.username ?? "Someone")
        .replaceAll("{creatorEmail}", creator?.email ?? "")
        .replaceAll("{shareUrl}", shareUrl)
        .replaceAll("{name}", shareName ?? "")
        .replaceAll("{desc}", description ?? "No description")
        .replaceAll(
          "{expires}",
          moment(expiration).unix() != 0
            ? moment(expiration).format("DD.MM.YYYY HH:mm")
            : "never",
        ),
    );
  }

  async sendMailToReverseShareCreator(
    recipientEmail: string,
    shareId: string,
    e2eKeyFragment?: string,
  ) {
    const baseUrl = `${this.config.get("general.appUrl")}/s/${shareId}`;
    const shareUrl = e2eKeyFragment
      ? `${baseUrl}#key=${e2eKeyFragment}`
      : baseUrl;

    await this.sendMail(
      recipientEmail,
      this.config.get("email.reverseShareSubject"),
      this.config
        .get("email.reverseShareMessage")
        .replaceAll("\\n", "\n")
        .replaceAll("{shareUrl}", shareUrl),
    );
  }

  async sendResetPasswordEmail(recipientEmail: string, token: string) {
    const resetPasswordUrl = `${this.config.get(
      "general.appUrl",
    )}/auth/resetPassword/${token}`;

    await this.sendMail(
      recipientEmail,
      this.config.get("email.resetPasswordSubject"),
      this.config
        .get("email.resetPasswordMessage")
        .replaceAll("\\n", "\n")
        .replaceAll("{url}", resetPasswordUrl),
    );
  }

  async sendEmailVerificationEmail(
    recipientEmail: string,
    token: string,
  ): Promise<void> {
    const appUrl = this.config.get("general.appUrl").replace(/\/$/, "");
    // Keep the secret in the fragment: browsers do not send it in HTTP request
    // lines or Referer headers. The verification page removes it immediately.
    const verificationUrl = `${appUrl}/auth/verify-email#token=${token}`;
    const appName = this.config.get("general.appName");

    await this.sendMail(
      recipientEmail,
      `Verify your email address for ${appName}`,
      buildEmailVerificationMessage(appName, verificationUrl),
    );
  }

  async sendInviteEmail(recipientEmail: string, password: string) {
    const loginUrl = `${this.config.get("general.appUrl")}/auth/signIn`;

    await this.sendMail(
      recipientEmail,
      this.config.get("email.inviteSubject"),
      this.config
        .get("email.inviteMessage")
        .replaceAll("{url}", loginUrl)
        .replaceAll("{password}", password)
        .replaceAll("{email}", recipientEmail),
    );
  }

  async sendTestMail(recipientEmail: string) {
    await this.getTransporter()
      .sendMail({
        from: `"${this.config.get("general.appName")}" <${this.config.get(
          "smtp.email",
        )}>`,
        to: recipientEmail,
        subject: "Test email",
        text: "This is a test email",
      })
      .catch((e) => {
        this.logger.error(e);
        throw new InternalServerErrorException(e.message);
      });
  }

  async sendDownloadNotification(
    recipientEmail: string,
    shareName: string,
    date: string,
    shareUrl: string,
  ) {
    await this.sendMail(
      recipientEmail,
      this.config.get("email.downloadNotificationSubject"),
      this.config
        .get("email.downloadNotificationMessage")
        .replaceAll("\\n", "\n")
        .replaceAll("{shareName}", shareName)
        .replaceAll("{date}", date)
        .replaceAll("{shareUrl}", shareUrl),
    );
  }

  async sendTeamShareNotificationEmail(
    recipientEmail: string,
    teamName?: string,
  ) {
    const appUrl = this.config.get("general.appUrl");
    const subject = this.config.get("email.teamShareNotificationSubject");

    // E2EE team shares are zero-knowledge: the email never exposes the sender
    // name or file name. Detailed metadata stays in the encrypted in-app feed.
    const body = this.config
      .get("email.teamShareNotificationMessage")
      .replaceAll("\\n", "\n")
      .replaceAll("{sender}", "A team member")
      .replaceAll("{fileName}", "an encrypted file")
      .replaceAll("{teamName}", teamName || "your team")
      .replaceAll("{appUrl}", appUrl);

    await this.sendMail(recipientEmail, subject, body);
  }

  async sendDownloadDigest(
    recipientEmail: string,
    digest: string,
    mode: "digest" | "weekly",
  ) {
    const subjectKey =
      mode === "weekly"
        ? "email.downloadWeeklySubject"
        : "email.downloadDigestSubject";
    const messageKey =
      mode === "weekly"
        ? "email.downloadWeeklyMessage"
        : "email.downloadDigestMessage";

    await this.sendMail(
      recipientEmail,
      this.config.get(subjectKey),
      this.config
        .get(messageKey)
        .replaceAll("\\n", "\n")
        .replaceAll("{digest}", digest),
    );
  }
}
