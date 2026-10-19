import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { User } from "@prisma/client";
import { Request } from "express";
import {
  EVIDENCE_VAULT_COOKIE,
  EvidenceVaultService,
} from "./evidenceVault.service";

/**
 * Runs after AuthenticatedUserGuard and AdministratorGuard: the vault must also have been
 * opened with a passkey by this very administrator, a few minutes ago.
 */
@Injectable()
export class EvidenceVaultGuard implements CanActivate {
  constructor(private vault: EvidenceVaultService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as User | undefined;
    if (
      !user?.isAdmin ||
      !(await this.vault.openUntil(
        request.cookies?.[EVIDENCE_VAULT_COOKIE],
        user,
      ))
    ) {
      throw new ForbiddenException(
        "The evidence vault is locked",
        "vault_locked",
      );
    }
    return true;
  }
}
