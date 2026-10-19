import { JwtService } from "@nestjs/jwt";
import type { Request, Response } from "express";

const cookieJwt = new JwtService();

/** Verify existing visit cookies before using their claims for cleanup. */
export function writeShareTokenCookie(
  request: Request,
  response: Response,
  shareId: string,
  token: string,
  secure: boolean,
  jwtSecret: string,
) {
  const key = `share_${shareId}_token`;
  const retained: { key: string; issuedAt: number }[] = [];
  for (const [name, value] of Object.entries(request.cookies || {})) {
    if (name === key || !name.startsWith("share_") || !name.endsWith("_token"))
      continue;
    try {
      if (typeof value !== "string" || !value || value.length > 8192)
        throw new Error("Invalid visit cookie");
      const claims = cookieJwt.verify<{
        shareId?: unknown;
        iat?: unknown;
      }>(value, { secret: jwtSecret, algorithms: ["HS256"] });
      if (claims.shareId !== name.slice("share_".length, -"_token".length))
        throw new Error("Visit cookie belongs to another share");
      if (
        claims.iat != null &&
        (typeof claims.iat !== "number" || !Number.isFinite(claims.iat))
      )
        throw new Error("Invalid issued-at claim");
      retained.push({
        key: name,
        issuedAt: typeof claims.iat === "number" ? claims.iat : 0,
      });
    } catch {
      response.clearCookie(name, { path: "/" });
    }
  }
  retained.sort((a, b) => b.issuedAt - a.issuedAt);
  for (const old of retained.slice(9))
    response.clearCookie(old.key, { path: "/" });
  response.cookie(key, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure,
    maxAge: 24 * 60 * 60 * 1000,
  });
}

/** Return the visit token scoped to this share. */
export function readShareVisitToken(
  request: Request,
  shareId: string,
): string | undefined {
  return request.cookies?.[`share_${shareId}_token`];
}
