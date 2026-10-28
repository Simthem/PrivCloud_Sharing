import { GenericOidcProvider } from "./genericOidc.provider";
import { ConfigService } from "../../config/config.service";
import { JwtService } from "@nestjs/jwt";
import { Injectable } from "@nestjs/common";

@Injectable()
export class GoogleProvider extends GenericOidcProvider {
  constructor(config: ConfigService, jwtService: JwtService) {
    super("google", ["oauth.google-enabled"], config, jwtService);
  }

  protected getExpectedIssuers(): string[] {
    // Both values are documented Google ID-token issuers. This exception stays
    // Google-specific: custom OIDC providers still require their exact issuer.
    return ["https://accounts.google.com", "accounts.google.com"];
  }

  protected getDiscoveryUri(): string {
    return "https://accounts.google.com/.well-known/openid-configuration";
  }
}
