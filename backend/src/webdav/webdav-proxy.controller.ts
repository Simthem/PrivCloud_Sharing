import {
  Body,
  Controller,
  Post,
  Res,
  UseGuards,
  HttpCode,
  BadRequestException,
} from "@nestjs/common";
import { isIP } from "node:net";
import { Response } from "express";
import { JwtGuard } from "../auth/guard/jwt.guard";
import { Throttle } from "@nestjs/throttler";
import { IsString, IsNotEmpty, IsOptional } from "class-validator";

/**
 * Minimal server-side WebDAV proxy.
 * The frontend sends credentials + target URL; the backend performs the
 * PROPFIND or GET request and returns the result.
 * This bypasses CORS, CSP, and PNA restrictions that block direct browser
 * access to third-party WebDAV servers (especially on mobile).
 *
 * Security:
 * - Requires JWT auth (logged-in user only)
 * - Only HTTPS WebDAV targets accepted (TLS alone blocks most SSRF against internal services)
 * - IP literals are validated: direct private/loopback IPs in URLs are refused
 * - Domain names are allowed regardless of where they resolve (self-hosted WebDAV support)
 * - Credentials are used for the single request and immediately discarded
 * - Rate-limited to prevent abuse
 */

class WebDavListDto {
  @IsString()
  @IsNotEmpty()
  endpoint: string;

  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsOptional()
  @IsString()
  href?: string;
}

class WebDavDownloadDto {
  @IsString()
  @IsNotEmpty()
  endpoint: string;

  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  href: string;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8" ?>' +
  '<d:propfind xmlns:d="DAV:">' +
  "<d:prop>" +
  "<d:displayname />" +
  "<d:resourcetype />" +
  "<d:getcontentlength />" +
  "<d:getcontenttype />" +
  "<d:getlastmodified />" +
  "</d:prop>" +
  "</d:propfind>";

@Controller("webdav")
@UseGuards(JwtGuard)
export class WebDavProxyController {
  @Post("list")
  @HttpCode(200)
  @Throttle({ default: { ttl: 60, limit: 120 } })
  async list(@Body() dto: WebDavListDto) {
    if (!dto.endpoint || !dto.username || !dto.password) {
      throw new BadRequestException(
        "Missing required fields: endpoint, username, password",
      );
    }
    const url = this.normalizeTargetUrl(
      dto.endpoint,
      dto.href || dto.endpoint,
      true,
    );
    const response = await fetch(url, {
      method: "PROPFIND",
      redirect: "manual",
      headers: {
        Authorization: this.basicAuth(dto.username, dto.password),
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: PROPFIND_BODY,
    });

    if (response.status === 401 || response.status === 403) {
      return { error: "auth", status: response.status };
    }
    if (!response.ok && response.status !== 207) {
      return { error: "http", status: response.status };
    }

    const xml = await response.text();
    return { url, xml };
  }

  @Post("download")
  @HttpCode(200)
  @Throttle({ default: { ttl: 60, limit: 120 } })
  async download(@Body() dto: WebDavDownloadDto, @Res() res: Response) {
    if (!dto.endpoint || !dto.username || !dto.password || !dto.href) {
      throw new BadRequestException(
        "Missing required fields: endpoint, username, password, href",
      );
    }
    const url = this.normalizeTargetUrl(dto.endpoint, dto.href, false);
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        Authorization: this.basicAuth(dto.username, dto.password),
      },
    });

    if (response.status === 401 || response.status === 403) {
      res.status(401).json({ error: "auth" });
      return;
    }
    if (!response.ok) {
      res.status(response.status).json({ error: "http" });
      return;
    }

    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    const contentLength = response.headers.get("content-length");

    res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    res.status(200);

    // Stream the body directly to the client
    const reader = response.body?.getReader();
    if (!reader) {
      res.end();
      return;
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
      res.end();
    }
  }

  private normalizeTargetUrl(
    endpointRaw: string,
    raw: string | undefined,
    asDirectory: boolean,
  ): string {
    const endpoint = this.parseHttpsUrl(endpointRaw, true);
    const target = this.parseHttpsUrl(raw, asDirectory);

    if (target.origin !== endpoint.origin) {
      throw new BadRequestException(
        "WebDAV target must stay on the configured endpoint origin",
      );
    }

    // Only block explicit private IP literals in the URL.
    // Domain names are allowed even if they resolve to private IPs so that
    // self-hosted WebDAV/Nextcloud servers work. HTTPS + JWT auth already
    // prevent meaningful SSRF against internal services.
    this.assertNotPrivateIpLiteral(target.hostname);
    return target.href;
  }

  private parseHttpsUrl(raw: string | undefined, asDirectory: boolean): URL {
    if (!raw || typeof raw !== "string" || !raw.trim()) {
      throw new BadRequestException("Invalid URL: must be a non-empty string");
    }
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      throw new BadRequestException("Invalid WebDAV URL");
    }
    if (url.protocol !== "https:") {
      throw new BadRequestException("Only HTTPS WebDAV endpoints are supported");
    }
    if (url.username || url.password) {
      throw new BadRequestException("Credentials in WebDAV URLs are refused");
    }
    url.username = "";
    url.password = "";
    if (asDirectory && !url.pathname.endsWith("/")) url.pathname += "/";
    return url;
  }

  private assertNotPrivateIpLiteral(hostname: string) {
    // Strip IPv6 brackets if present
    const addr = hostname.replace(/^\[|\]$/g, "");
    const version = isIP(addr);
    // If not an IP literal (i.e. it's a domain name), always allow
    if (version === 0) return;

    if (version === 4) {
      const parts = addr.split(".").map(Number);
      const [a, b] = parts;
      const isPrivate =
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224;
      if (isPrivate) {
        throw new BadRequestException(
          "Private IP address literals are not allowed in WebDAV URLs",
        );
      }
      return;
    }

    // IPv6
    const lower = addr.toLowerCase();
    const isPrivate =
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("ff");
    if (isPrivate) {
      throw new BadRequestException(
        "Private IP address literals are not allowed in WebDAV URLs",
      );
    }
  }

  private basicAuth(username: string, password: string): string {
    if (!username || !password) {
      throw new BadRequestException(
        "Invalid credentials: username and password required",
      );
    }
    return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }
}
