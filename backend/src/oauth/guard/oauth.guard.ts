import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

@Injectable()
export class OAuthGuard implements CanActivate {
  constructor() {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const provider = request.params.provider;
    const cookieValue: string =
      request.cookies[`oauth_${provider}_state`] ?? "";
    // Cookie may contain state|nonce -- only the state part is compared.
    const pipeIdx = cookieValue.indexOf("|");
    const cookieState = pipeIdx !== -1 ? cookieValue.substring(0, pipeIdx) : cookieValue;
    return request.query.state === cookieState;
  }
}
