import {
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from "@nestjs/common";
import { minutes, Throttle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { AuthenticatedUserGuard } from "src/auth/guard/authenticatedUser.guard";
import { AccountPasskeyService } from "./accountPasskey.service";

/**
 * Passkeys added from the account settings. Adding one goes through
 * auth/passkey/registration (step-up), signing passkeys keep their own
 * routes and are accepted for sign-in and approvals as well.
 */
@Controller("passkeys")
@UseGuards(AuthenticatedUserGuard)
export class PasskeyController {
  constructor(private passkeys: AccountPasskeyService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  list(@GetUser() user: User) {
    return this.passkeys.list(user);
  }

  @Delete(":passkeyId")
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  remove(
    @Param("passkeyId", ParseUUIDPipe) passkeyId: string,
    @GetUser() user: User,
  ) {
    return this.passkeys.remove(user, passkeyId);
  }
}
