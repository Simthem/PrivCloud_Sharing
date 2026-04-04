import { GenericOidcProvider } from "./genericOidc.provider";
import { ConfigService } from "../../config/config.service";
import { JwtService } from "@nestjs/jwt";
import { Injectable } from "@nestjs/common";

@Injectable()
export class MicrosoftProvider extends GenericOidcProvider {
  constructor(
    config: ConfigService,
    jwtService: JwtService,
  ) {
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
}
