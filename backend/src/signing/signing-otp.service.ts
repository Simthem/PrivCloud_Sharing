import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { PrismaService } from "src/prisma/prisma.service";
import { EmailService } from "src/email/email.service";
import { ConfigService } from "src/config/config.service";

const MAX_OTP_FAILURES = 5;

@Injectable()
export class SigningOtpService {
  private readonly logger = new Logger(SigningOtpService.name);

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
    private configService: ConfigService,
  ) {}

  /**
   * Send OTP to a recipient for AES identity verification.
   */
  async sendOtp(signingToken: string) {
    const recipient = await this.prisma.signatureRecipient.findUnique({
      where: { signingToken },
      include: { document: true },
    });

    if (!recipient) throw new NotFoundException("Invalid signing link");
    if (recipient.otpVerified) {
      throw new BadRequestException("Identity already verified");
    }

    // Rate limit: max 1 OTP per 60 seconds
    if (
      recipient.otpSentAt &&
      Date.now() - recipient.otpSentAt.getTime() < 60_000
    ) {
      throw new BadRequestException(
        "Please wait 60 seconds before requesting a new code",
      );
    }

    // Generate 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const otpHash = this.hmacOtp(otp);

    await this.prisma.signatureRecipient.update({
      where: { id: recipient.id },
      data: { otpHash, otpSentAt: new Date(), otpFailures: 0 },
    });

    // Send OTP via email
    await this.emailService.sendMail(
      recipient.email,
      "Code de vérification - Signature électronique",
      `Votre code de vérification pour signer le document "${recipient.document.fileName}" est : ${otp}\n\nCe code expire dans 10 minutes.\n\nSi vous n'avez pas demandé ce code, ignorez cet email.`,
    );

    await this.createAuditEvent(
      recipient.documentId,
      "OTP_SENT",
      recipient.email,
    );

    return { message: "OTP sent to your email" };
  }

  /**
   * Verify OTP for AES identity verification.
   */
  async verifyOtp(signingToken: string, otpCode: string) {
    const recipient = await this.prisma.signatureRecipient.findUnique({
      where: { signingToken },
    });

    if (!recipient) throw new NotFoundException("Invalid signing link");
    if (recipient.otpVerified) {
      return { verified: true };
    }

    if (!recipient.otpHash || !recipient.otpSentAt) {
      throw new BadRequestException("No OTP has been sent. Request one first.");
    }

    // Check failure lockout
    if (recipient.otpFailures >= MAX_OTP_FAILURES) {
      throw new BadRequestException(
        "Too many failed attempts. Please request a new code.",
      );
    }

    // Check expiration (10 minutes)
    if (Date.now() - recipient.otpSentAt.getTime() > 10 * 60_000) {
      throw new BadRequestException("OTP expired. Please request a new one.");
    }

    // Verify HMAC
    const inputHash = this.hmacOtp(otpCode);

    if (!crypto.timingSafeEqual(Buffer.from(inputHash, "hex"), Buffer.from(recipient.otpHash, "hex"))) {
      await this.prisma.signatureRecipient.update({
        where: { id: recipient.id },
        data: { otpFailures: { increment: 1 } },
      });
      throw new BadRequestException("Invalid OTP code");
    }

    await this.prisma.signatureRecipient.update({
      where: { id: recipient.id },
      data: { otpVerified: true },
    });

    await this.createAuditEvent(
      recipient.documentId,
      "OTP_VERIFIED",
      recipient.email,
    );

    return { verified: true };
  }

  private hmacOtp(otp: string): string {
    const pepper = process.env.OTP_PEPPER || this.configService.get("internal.jwtSecret");
    return crypto.createHmac("sha256", pepper).update(otp).digest("hex");
  }

  private async createAuditEvent(
    documentId: string,
    eventType: string,
    actor: string,
    ipAddress?: string,
    userAgent?: string,
    metadata?: string,
  ) {
    await this.prisma.signatureAuditEvent.create({
      data: { documentId, eventType, actor, ipAddress, userAgent, metadata },
    });
  }
}
