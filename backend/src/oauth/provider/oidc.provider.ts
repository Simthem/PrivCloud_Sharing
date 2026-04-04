import { GenericOidcProvider, OidcToken } from "./genericOidc.provider";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "../../config/config.service";
import { JwtService } from "@nestjs/jwt";
import { OAuthCallbackDto } from "../dto/oauthCallback.dto";
import { OAuthSignInDto } from "../dto/oauthSignIn.dto";
import { OAuthToken } from "./oauthProvider.interface";

@Injectable()
export class OidcProvider extends GenericOidcProvider {
  constructor(
    config: ConfigService,
    jwtService: JwtService,
  ) {
    super(
      "oidc",
      ["oauth.oidc-enabled", "oauth.oidc-discoveryUri"],
      config,
      jwtService,
    );
  }

  protected getDiscoveryUri(): string {
    return this.config.get("oauth.oidc-discoveryUri");
  }

  getUserInfo(
    token: OAuthToken<OidcToken>,
    query: OAuthCallbackDto,
    _?: string,
  ): Promise<OAuthSignInDto> {
    const claim = this.config.get("oauth.oidc-usernameClaim") || undefined;
    const rolePath = this.config.get("oauth.oidc-rolePath") || undefined;
    const roleGeneralAccess =
      this.config.get("oauth.oidc-roleGeneralAccess") || undefined;
    const roleAdminAccess =
      this.config.get("oauth.oidc-roleAdminAccess") || undefined;
    return super.getUserInfo(token, query, claim, {
      path: rolePath,
      generalAccess: roleGeneralAccess,
      adminAccess: roleAdminAccess,
    });
  }
}
