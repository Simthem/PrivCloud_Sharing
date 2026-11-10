import { isEmail } from "class-validator";
import {
  createHash,
  createPrivateKey,
  randomUUID,
  X509Certificate,
} from "crypto";
import { readFile } from "fs/promises";
import {
  GenericOidcProvider,
  OidcConfiguration,
  OidcIdToken,
} from "./genericOidc.provider";
import { ConfigService } from "../../config/config.service";
import { JwtService } from "@nestjs/jwt";
import { Injectable } from "@nestjs/common";
import * as jose from "jose";
import { ErrorPageException } from "../exceptions/errorPage.exception";

const TENANT_PLACEHOLDER = "{tenantid}";
const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const CERTIFICATE_RENEWAL_NOTICE_MS = 30 * 24 * 60 * 60 * 1000;
const TENANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class MicrosoftProvider extends GenericOidcProvider {
  constructor(config: ConfigService, jwtService: JwtService) {
    super(
      "microsoft",
      ["oauth.microsoft-enabled", "oauth.microsoft-tenant"],
      config,
      jwtService,
    );
  }

  protected getDiscoveryUri(): string {
    return `https://login.microsoftonline.com/${this.config.get(
      "oauth.microsoft-tenant",
    )}/v2.0/.well-known/openid-configuration`;
  }

  protected async getClientCredentials(
    tokenEndpoint: string,
  ): Promise<Record<string, string>> {
    const certificateFile =
      process.env.MICROSOFT_OAUTH_CERTIFICATE_FILE?.trim();
    if (!certificateFile) return super.getClientCredentials(tokenEndpoint);

    return {
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await this.signClientAssertion(
        certificateFile,
        tokenEndpoint,
      ),
    };
  }

  private async signClientAssertion(file: string, tokenEndpoint: string) {
    let certificate: X509Certificate;
    let privateKey: ReturnType<typeof createPrivateKey>;
    try {
      const pem = await readFile(file, "utf8");
      certificate = new X509Certificate(pem);
      privateKey = createPrivateKey(pem);
    } catch {
      this.logger.error("Microsoft certificate file cannot be used");
      throw new ErrorPageException("invalid_token");
    }

    const remaining = new Date(certificate.validTo).getTime() - Date.now();
    if (remaining <= 0) {
      this.logger.error("Microsoft certificate has expired");
      throw new ErrorPageException("invalid_token");
    }
    if (remaining < CERTIFICATE_RENEWAL_NOTICE_MS) {
      this.logger.warn("Microsoft certificate expires in less than 30 days");
    }

    const clientId = this.config.getOAuth(this.name, "clientId");
    return new jose.SignJWT({})
      .setProtectedHeader({
        alg: "PS256",
        typ: "JWT",
        "x5t#S256": createHash("sha256")
          .update(certificate.raw)
          .digest("base64url"),
      })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(tokenEndpoint)
      .setJti(randomUUID())
      .setIssuedAt()
      .setNotBefore("0s")
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  // The common and organizations metadata publish a template, not an issuer.
  protected getExpectedIssuers(
    configuration: OidcConfiguration,
    idToken: OidcIdToken,
  ): string {
    const { issuer } = configuration;
    return idToken.tid && TENANT_ID.test(idToken.tid)
      ? issuer.replace(TENANT_PLACEHOLDER, idToken.tid)
      : issuer;
  }

  // Entra never sends email_verified, and a tenant admin can set any email.
  protected hasVerifiedEmail(idToken: OidcIdToken): boolean {
    const verified = [true, "true", 1, "1"].includes(idToken.xms_edov);
    if (!verified) {
      const address = idToken.email ? "present" : "absent";
      const domainOwner =
        idToken.xms_edov === undefined ? "absent" : "unverified";
      this.logger.warn(
        `Address not trusted (claim ${address}, xms_edov ${domainOwner})`,
      );
    }
    return verified;
  }

  // Accounts without a mail attribute still have their sign-in address.
  protected unverifiedEmail(idToken: OidcIdToken): string | undefined {
    const address = idToken.email ?? idToken.preferred_username;
    return typeof address === "string" && isEmail(address)
      ? address.toLowerCase()
      : undefined;
  }
}
