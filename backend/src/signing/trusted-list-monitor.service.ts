import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import * as crypto from "crypto";
import * as https from "https";
import { ConfigService } from "src/config/config.service";
import { EmailService } from "src/email/email.service";
import { PrismaService } from "src/prisma/prisma.service";
import {
  SignedTrustedList,
  evaluatePinnedTsa,
  listSignerIsAuthorized,
  officialJournalReferences,
  parseListPointers,
  parseTrustedList,
  verifyTrustedListSignature,
} from "./trusted-list.util";

const MAX_LIST_BYTES = 50 * 1024 * 1024;
const DAY_MS = 86_400_000;
const RETRY_AFTER_ERROR_MS = 3_600_000;
const DEFAULT_LOTL_URL = "https://ec.europa.eu/tools/lotl/eu-lotl.xml";

const subjectOf = (certificate: crypto.X509Certificate) =>
  certificate.subject.split("\n").join(", ");

export const pinnedTsaFingerprints = () =>
  (process.env.SIGNING_TSA_TRUSTED_CERT_SHA256 || "")
    .split(",")
    .map((fingerprint) => fingerprint.replace(/:/g, "").trim().toLowerCase())
    .filter((fingerprint) => fingerprint.length > 0);

/**
 * Checks every day that the pinned TSA certificate authority is still a
 * granted qualified time stamp service in its Trusted List, records the trace
 * and e-mails it to the instance administrators.
 */
@Injectable()
export class TrustedListMonitorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TrustedListMonitorService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private emailService: EmailService,
  ) {}

  private get listUrl() {
    return process.env.SIGNING_TSA_TRUSTED_LIST_URL?.trim() || "";
  }

  /** A fresh instance checks right away instead of waiting for the next day. */
  onApplicationBootstrap() {
    if (!this.listUrl) return;
    setTimeout(() => {
      void this.checkIfStale().catch((error) =>
        this.logger.error(`Trusted List check failed: ${error?.message}`),
      );
    }, 30_000).unref();
  }

  private async checkIfStale() {
    const latest = await this.latest();
    // A failed check is retried instead of waiting for the next day.
    if (
      latest &&
      latest.result === "OK" &&
      Date.now() - latest.checkedAt.getTime() < DAY_MS
    )
      return;
    await this.check();
  }

  latest() {
    return this.prisma.trustedListCheck.findFirst({
      orderBy: { checkedAt: "desc" },
    });
  }

  async check(retryOnError = true) {
    const listUrl = this.listUrl;
    if (!listUrl) return null;
    const checkedAt = new Date();
    const lines = [
      `Date: ${checkedAt.toISOString()}`,
      `Trusted List: ${listUrl}`,
      `Pinned TSA certificates: ${pinnedTsaFingerprints().join(", ") || "none"}`,
    ];
    let result: "OK" | "ALERT" | "ERROR";
    let listSha256: string | null = null;
    let sequenceNumber: string | null = null;
    let nextUpdate: Date | null = null;
    try {
      const xml = await this.download(listUrl);
      listSha256 = crypto.createHash("sha256").update(xml).digest("hex");
      lines.push(`List SHA-256: ${listSha256}`);
      const signed = verifyTrustedListSignature(xml.toString("utf8"));
      const list = parseTrustedList(signed.signedXml);
      sequenceNumber = list.sequenceNumber;
      nextUpdate = list.nextUpdate;
      lines.push(
        `List territory: ${list.territory || "unknown"}`,
        `List sequence number: ${sequenceNumber || "unknown"}`,
        `List issued: ${list.issuedAt?.toISOString() || "unknown"}`,
        `Next update announced: ${nextUpdate?.toISOString() || "unknown"}`,
      );
      const anchoring = await this.checkListSigner(list.territory, signed, checkedAt);
      const evaluation = evaluatePinnedTsa(list, pinnedTsaFingerprints(), checkedAt);
      result = anchoring.ok && evaluation.result === "OK" ? "OK" : "ALERT";
      lines.push(...anchoring.lines, ...evaluation.lines);
    } catch (error: any) {
      result = "ERROR";
      const cause = error?.cause?.message || error?.code;
      lines.push(
        `The list could not be read: ${error?.message || error}` +
          (cause && cause !== error?.message ? ` (${cause})` : ""),
      );
    }
    lines.push(`Result: ${result}`);
    const trace = lines.join("\n");
    const record = await this.prisma.trustedListCheck.create({
      data: {
        checkedAt,
        listUrl,
        listSha256,
        sequenceNumber,
        nextUpdate,
        result,
        trace,
      },
    });
    if (result === "OK") {
      this.logger.log("Trusted List check of the qualified TSA: OK");
    } else {
      this.logger.warn(
        `Trusted List check of the qualified TSA: ${result}\n${trace}`,
      );
    }
    if (result === "ERROR" && retryOnError) {
      // A network failure is often transient: try once more an hour later.
      setTimeout(() => {
        void this.check(false).catch((error) =>
          this.logger.error(`Trusted List check failed: ${error?.message}`),
        );
      }, RETRY_AFTER_ERROR_MS).unref();
    }
    await this.mailAdministrators(result, trace);
    return record;
  }

  /**
   * The list signer must hold a valid certificate that the EU List of Trusted
   * Lists, itself signed, gives for the list's territory.
   */
  private async checkListSigner(
    territory: string | null,
    signed: SignedTrustedList,
    now: Date,
  ) {
    const signerValid =
      new Date(signed.signer.validFrom) <= now &&
      now <= new Date(signed.signer.validTo);
    const lines = [
      `List signature: VALID, signed by ${subjectOf(signed.signer)}`,
      `List signer certificate: SHA-256 ${signed.signerSha256}, ` +
        `${signerValid ? "valid" : "NOT VALID"} until ${new Date(signed.signer.validTo).toISOString()}`,
    ];
    const lotlUrl = process.env.SIGNING_TSA_LOTL_URL?.trim() || DEFAULT_LOTL_URL;
    const lotlXml = await this.download(lotlUrl);
    const lotl = verifyTrustedListSignature(lotlXml.toString("utf8"));
    const pointers = parseListPointers(lotl.signedXml);
    const authorized = listSignerIsAuthorized(
      pointers,
      territory,
      signed.signerSha256,
    );
    const lotlSelfListed = listSignerIsAuthorized(
      pointers,
      "EU",
      lotl.signerSha256,
    );
    lines.push(
      `EU List of Trusted Lists: ${lotlUrl}, sequence ${parseTrustedList(lotl.signedXml).sequenceNumber || "unknown"}, ` +
        `SHA-256 ${crypto.createHash("sha256").update(lotlXml).digest("hex")}`,
      `EU List of Trusted Lists signature: VALID, signed by ${subjectOf(lotl.signer)}, SHA-256 ${lotl.signerSha256}`,
      `EU List of Trusted Lists signer listed in its own EU pointer: ${lotlSelfListed ? "YES" : "NO"}`,
      `List signer authorized by the EU List of Trusted Lists for ${territory || "unknown"}: ${authorized ? "YES" : "NO"}`,
      `Certificates allowed to sign the EU List of Trusted Lists are published in the Official Journal: ${
        officialJournalReferences(lotl.signedXml).join(", ") || "reference not found"
      }`,
    );
    return { ok: signerValid && authorized && lotlSelfListed, lines };
  }

  private async mailAdministrators(result: string, trace: string) {
    // No feature may require SMTP: without it the trace stays in the database
    // and in the logs.
    if (!this.config.get("smtp.enabled")) {
      this.logger.warn("SMTP disabled: Trusted List check trace not e-mailed");
      return;
    }
    const administrators = await this.prisma.user.findMany({
      where: { isAdmin: true },
      select: { email: true },
    });
    const subject =
      result === "OK"
        ? "[PrivCloud] Contrôle de la TSA qualifiée : OK"
        : `[PrivCloud] ALERTE contrôle de la TSA qualifiée : ${result}`;
    const body =
      "Bonjour,\n\n" +
      "Voici la trace du contrôle quotidien de l'autorité d'horodatage qualifiée " +
      "utilisée pour sceller les signatures.\n\n" +
      `${trace}\n\n` +
      (result === "OK"
        ? "Aucune action n'est nécessaire.\n"
        : "Les horodatages obtenus en l'état pourraient ne plus être qualifiés. " +
          "Vérifiez la liste de confiance et la configuration SIGNING_TSA_*.\n") +
      "\n-- \nPrivCloud Sharing";
    for (const { email } of administrators) {
      await this.emailService
        .sendMail(email, subject, body)
        .catch((error) =>
          this.logger.error(
            `Trusted List trace not delivered to ${email}: ${error?.message}`,
          ),
        );
    }
  }

  private download(listUrl: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const url = new URL(listUrl);
      if (url.protocol !== "https:") {
        reject(new Error("The Trusted List URL must use HTTPS"));
        return;
      }
      const request = https.get(url, { timeout: 60_000 }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_LIST_BYTES) {
            request.destroy(new Error("The Trusted List is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      });
      request.on("timeout", () =>
        request.destroy(new Error("Trusted List download timed out")),
      );
      request.on("error", reject);
    });
  }
}
