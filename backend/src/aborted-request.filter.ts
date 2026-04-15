import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";

/**
 * Global exception filter that silences two categories of expected errors
 * so they don't pollute logs with full stack traces:
 *
 * 1. "Request aborted" (ECONNABORTED) -- client cancelled an upload/download.
 * 2. Share-security 403s -- the guard rejects unauthenticated access to a
 *    password-protected or private share.  The frontend handles these by
 *    showing a password modal; they are NOT server bugs.
 */
@Catch()
export class AbortedRequestFilter implements ExceptionFilter {
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

    // Re-throw anything else so the default NestJS handler takes over.
    throw exception;
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
}
