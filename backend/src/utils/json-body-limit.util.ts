import { JwtService } from "@nestjs/jwt";
import { json } from "body-parser";
import type { NextFunction, Request, Response } from "express";

const jwt = new JwtService();
const ACCESS_COOKIE = /(?:^|;\s*)access_token=([^;]+)/;

/** A well-signed, unexpired access token, checked before any body is read. */
export function hasSignedSession(request: Request, secret: string): boolean {
  const header = request.headers.authorization;
  const cookie = ACCESS_COOKIE.exec(request.headers.cookie ?? "")?.[1];
  const token = cookie
    ? decodeURIComponent(cookie)
    : header?.startsWith("Bearer ")
      ? header.slice(7).trim()
      : undefined;
  if (!token || !secret) return false;
  try {
    jwt.verify(token, { secret, algorithms: ["HS256"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * JSON bodies of anonymous callers stay small. Signed-in users, and the
 * signing links whose signature images weigh a few megabytes, get more.
 */
export function sizedJsonParser(options: {
  secret: () => string;
  sessionLimit: string;
  visitorLimit: string;
  largePrefixes: string[];
}) {
  // Kept for webhook signature checks, as Nest's own parser does.
  const verify = (
    request: Request & { rawBody?: Buffer },
    _: unknown,
    buffer: Buffer,
  ) => {
    if (Buffer.isBuffer(buffer)) request.rawBody = buffer;
  };
  const large = json({ limit: options.sessionLimit, verify });
  const small = json({ limit: options.visitorLimit, verify });
  return (request: Request, response: Response, next: NextFunction) => {
    const allowed =
      options.largePrefixes.some((prefix) => request.path.startsWith(prefix)) ||
      hasSignedSession(request, options.secret());
    return (allowed ? large : small)(request, response, next);
  };
}
