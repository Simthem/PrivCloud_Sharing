import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

/** Require a session even when the instance allows anonymous uploads. */
@Injectable()
export class AuthenticatedUserGuard extends AuthGuard("jwt") {}
