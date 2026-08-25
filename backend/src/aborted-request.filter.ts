import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  HttpServer,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { Request, Response } from "express";

/**
 * Global exception filter that silences categories of expected errors
 * so they don't pollute logs with full stack traces:
 *
 * 1. "Request aborted" (ECONNABORTED) -- client cancelled an upload/download.
 * 2. Share-security 403s -- the guard rejects unauthenticated access to a
 *    password-protected or private share.  The frontend handles these by
 *    showing a password modal; they are NOT server bugs.
 * 3. Guard 403s ("Forbidden resource") -- a non-admin user hit an admin-only
 *    endpoint.  Normal operational noise, not a server bug.
 * 4. 401 on /auth/token -- refresh token absent or expired.
 */
@Catch()
export class AbortedRequestFilter
  extends BaseExceptionFilter
  implements ExceptionFilter
{
  private readonly logger = new Logger("AbortedRequest");

  private static readonly EXPECTED_SHARE_ERRORS = new Set([
    "share_password_required",
    "share_token_required",
    "private_share",
    "share_max_views_exceeded",
  ]);

  catch(exception: unknown, host: ArgumentsHost) {
    if (this.isAbortedRequest(exception)) {
      const ctx = host.switchToHttp();
      const req = ctx.getRequest<Request>();
      const res = ctx.getResponse<Response>();

      this.logger.warn(
        `Client aborted ${req.method} ${req.url} (received ${(exception as any).received ?? "?"}/${(exception as any).expected ?? "?"} bytes)`,
      );

      // The socket is already dead -- only send a response if still writable.
      if (!res.headersSent && res.writable) {
        res.status(499).end();
      }
      return;
    }

    // A direct browser navigation to an unknown API URL should land on the
    // existing Next.js 404 page. Programmatic API clients keep the normal JSON
    // 404 response so redirects/HTML can never break fetch or Axios callers.
    if (this.isHtmlNavigationRouteNotFound(exception, host)) {
      const response = host.switchToHttp().getResponse<Response>();
      if (!response.headersSent && response.writable) {
        response.redirect(302, "/404");
      }
      return;
    }

    // Expected share-security 403s: send the response silently.
    if (this.isExpectedShareSecurityError(exception)) {
      const ctx = host.switchToHttp();
      const res = ctx.getResponse<Response>();
      const httpEx = exception as HttpException;

      if (!res.headersSent && res.writable) {
        res.status(httpEx.getStatus()).json(httpEx.getResponse());
      }
      return;
    }

    // 401 on /auth/token: the refresh token is absent or expired.
    // This is expected (e.g. session expired, private browsing) and generates
    // only noise in the logs - send the 401 silently without a stack trace.
    // Also silences all other UnauthorizedException from JwtGuard - unauthenticated
    // users hitting protected endpoints is normal operational behavior.
    if (exception instanceof UnauthorizedException) {
      const ctx = host.switchToHttp();
      const res = ctx.getResponse<Response>();
      const httpEx = exception as HttpException;

      if (!res.headersSent && res.writable) {
        res.status(httpEx.getStatus()).json(httpEx.getResponse());
      }
      return;
    }

    // Guard-level 403 ("Forbidden resource") -- e.g. non-admin hitting admin
    // endpoints.  This is expected operational noise, not a server bug.
    if (this.isGuardForbidden(exception)) {
      const ctx = host.switchToHttp();
      const req = ctx.getRequest<Request>();
      const res = ctx.getResponse<Response>();
      const httpEx = exception as ForbiddenException;

      this.logger.debug(
        `Guard rejected ${req.method} ${req.url} (403 Forbidden resource)`,
      );

      if (!res.headersSent && res.writable) {
        res.status(httpEx.getStatus()).json(httpEx.getResponse());
      }
      return;
    }

    // Delegate everything else to Nest's canonical handler. Re-throwing from
    // a catch-all filter bypasses that handler, logs expected HttpExceptions
    // as uncaught stacks and may turn a normal 404 into a proxy-visible 500.
    return super.catch(exception, host);
  }

  constructor(applicationRef?: HttpServer) {
    super(applicationRef);
  }

  private isAbortedRequest(exception: unknown): boolean {
    if (!(exception instanceof Error)) return false;
    const err = exception as any;
    return (
      err.code === "ECONNABORTED" ||
      err.type === "request.aborted" ||
      (err.message && err.message.includes("request aborted"))
    );
  }

  private isExpectedShareSecurityError(exception: unknown): boolean {
    if (!(exception instanceof HttpException)) return false;
    const body = exception.getResponse();
    if (typeof body === "object" && body !== null) {
      return AbortedRequestFilter.EXPECTED_SHARE_ERRORS.has(
        (body as any).error,
      );
    }
    return false;
  }

  private isHtmlNavigationRouteNotFound(
    exception: unknown,
    host: ArgumentsHost,
  ): boolean {
    if (
      !(exception instanceof HttpException) ||
      exception.getStatus() !== 404
    ) {
      return false;
    }

    const request = host.switchToHttp().getRequest<Request>();
    if (request.method !== "GET" && request.method !== "HEAD") return false;

    const accept = request.headers.accept || "";
    if (
      !accept.split(",").some((value) => value.trim().startsWith("text/html"))
    ) {
      return false;
    }

    const body = exception.getResponse();
    const message =
      typeof body === "object" && body !== null
        ? (body as { message?: unknown }).message
        : body;
    return (
      typeof message === "string" &&
      /^Cannot (?:GET|HEAD) \/api(?:\/|$)/.test(message)
    );
  }

  private isGuardForbidden(exception: unknown): boolean {
    if (!(exception instanceof ForbiddenException)) return false;
    const body = exception.getResponse();
    // NestJS guards produce { statusCode: 403, message: "Forbidden resource" }
    if (typeof body === "object" && body !== null) {
      return (body as any).message === "Forbidden resource";
    }
    return exception.message === "Forbidden resource";
  }
}
