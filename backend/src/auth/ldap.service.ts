import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "../config/config.service";
import { Client, Entry, InvalidCredentialsError } from "ldapts";

@Injectable()
export class LdapService {
  private readonly logger = new Logger(LdapService.name);
  constructor(
    @Inject(ConfigService)
    private readonly serviceConfig: ConfigService,
  ) {}

  private async createLdapConnection(): Promise<Client> {
    const ldapUrl = this.serviceConfig.get("ldap.url");
    if (!ldapUrl) {
      throw new Error("LDAP server URL is not defined");
    }

    const isSecure = ldapUrl.startsWith("ldaps://");
    const ldapClient = new Client({
      url: ldapUrl,
      timeout: 15_000,
      connectTimeout: 15_000,
      tlsOptions: isSecure ? { minVersion: "TLSv1.2" } : undefined,
    });

    const bindDn = this.serviceConfig.get("ldap.bindDn") || null;
    if (bindDn) {
      try {
        await ldapClient.bind(
          bindDn,
          this.serviceConfig.get("ldap.bindPassword"),
        );
      } catch {
        this.logger.warn("Failed to bind the configured LDAP service account");
        throw new Error("failed to bind to default user");
      }
    }

    return ldapClient;
  }

  public async authenticateUser(
    username: string,
    password: string,
  ): Promise<Entry | null> {
    if (!username.match(/^[a-zA-Z0-9-_.@]+$/)) {
      this.logger.verbose("LDAP username validation failed");
      return null;
    }

    const searchBase = this.serviceConfig.get("ldap.searchBase");
    const searchQuery = this.serviceConfig
      .get("ldap.searchQuery")
      .replaceAll("%username%", username);

    const ldapClient = await this.createLdapConnection();
    try {
      const { searchEntries } = await ldapClient.search(searchBase, {
        filter: searchQuery,
        scope: "sub",

        attributes: ["*"],
        returnAttributeValues: true,
      });

      if (searchEntries.length > 1) {
        /* too many users found */
        this.logger.verbose("LDAP lookup returned multiple entries");
        return null;
      } else if (searchEntries.length == 0) {
        /* user not found */
        this.logger.verbose("LDAP lookup returned no entry");
        return null;
      }

      const targetEntity = searchEntries[0];
      this.logger.verbose("Trying LDAP user bind");
      try {
        await ldapClient.bind(targetEntity.dn, password);
        return targetEntity;
      } catch (error) {
        if (error instanceof InvalidCredentialsError) {
          this.logger.verbose("LDAP user bind rejected invalid credentials");
          return null;
        }

        this.logger.warn("LDAP user bind failed");
        return null;
      }
    } catch {
      this.logger.warn("LDAP lookup failed");
      return null;
    }
  }
}
