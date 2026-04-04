import { GenericOidcProvider } from "./genericOidc.provider";
import { ConfigService } from "../../config/config.service";
import { JwtService } from "@nestjs/jwt";
import { Injectable } from "@nestjs/common";

@Injectable()
export class GoogleProvider extends GenericOidcProvider {
  constructor(
    config: ConfigService,
    jwtService: JwtService,
  ) {
    super("google", ["oauth.google-enabled"], config, jwtService);
  }

  protected getDiscoveryUri(): string {
    return "https://accounts.google.com/.well-known/openid-configuration";
  }
}
