import {
  Body,
  Controller,
  Post,
  Res,
  UseGuards,
  HttpCode,
  BadRequestException,
} from "@nestjs/common";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
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
 * - Hostnames are resolved server-side and private/reserved addresses are refused
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

type ValidatedWebDavTarget = {
  href: string;
  url: URL;
  address: string;
  family: 4 | 6;
};

type WebDavRequestOptions = {
  method: "GET" | "PROPFIND";
  headers?: Record<string, string>;
  body?: string;
};

type WebDavUpstreamResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  stream: IncomingMessage;
  text: () => Promise<string>;
};

const WEBDAV_REQUEST_TIMEOUT_MS = 60_000;

type ResolvedPublicHost = {
  address: string;
  family: 4 | 6;
};

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
    const url = await this.normalizeTargetUrlOrBridgeRequired(
      dto.endpoint,
      dto.href || dto.endpoint,
      true,
    );
    if (!url) return { error: "bridge_required", status: 400 };

    const response = await this.requestWebDav(url, {
      method: "PROPFIND",
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
    if (!this.isSuccessfulStatus(response.status) && response.status !== 207) {
      return { error: "http", status: response.status };
    }

    const xml = await response.text();
    return { url: url.href, xml };
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
    const url = await this.normalizeTargetUrlOrBridgeRequired(
      dto.endpoint,
      dto.href,
      false,
    );
    if (!url) {
      res.status(200).json({ error: "bridge_required", status: 400 });
      return;
    }

    const response = await this.requestWebDav(url, {
      method: "GET",
      headers: {
        Authorization: this.basicAuth(dto.username, dto.password),
      },
    });

    if (response.status === 401 || response.status === 403) {
      response.stream.resume();
      res.status(401).json({ error: "auth" });
      return;
    }
    if (!this.isSuccessfulStatus(response.status)) {
      response.stream.resume();
      res.status(response.status).json({ error: "http" });
      return;
    }

    const contentType =
      this.headerValue(response.headers["content-type"]) ||
      "application/octet-stream";
    const contentLength = this.headerValue(response.headers["content-length"]);

    res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    res.status(200);

    response.stream.on("error", () => res.end());
    response.stream.pipe(res);
  }

  private async normalizeTargetUrl(
    endpointRaw: string,
    raw: string | undefined,
    asDirectory: boolean,
  ): Promise<ValidatedWebDavTarget> {
    const endpoint = this.parseHttpsUrl(endpointRaw, true);
    const target = this.parseHttpsUrl(raw, asDirectory);

    if (target.origin !== endpoint.origin) {
      throw new BadRequestException(
        "WebDAV target must stay on the configured endpoint origin",
      );
    }

    const resolved = await this.resolvePublicHost(target.hostname);
    return {
      href: target.href,
      url: target,
      address: resolved.address,
      family: resolved.family,
    };
  }

  private async normalizeTargetUrlOrBridgeRequired(
    endpointRaw: string,
    raw: string | undefined,
    asDirectory: boolean,
  ): Promise<ValidatedWebDavTarget | null> {
    try {
      return await this.normalizeTargetUrl(endpointRaw, raw, asDirectory);
    } catch (error) {
      if (this.isClientNetworkOnlyError(error)) return null;
      throw error;
    }
  }

  private isClientNetworkOnlyError(error: unknown): boolean {
    if (!(error instanceof BadRequestException)) return false;
    const response = error.getResponse();
    const message =
      typeof response === "string"
        ? response
        : Array.isArray((response as { message?: unknown }).message)
          ? (response as { message: string[] }).message.join(" ")
          : String((response as { message?: unknown }).message || "");

    return (
      message.includes("Unable to resolve WebDAV host") ||
      message.includes("Private or reserved WebDAV addresses are not allowed")
    );
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

  private async resolvePublicHost(hostname: string): Promise<ResolvedPublicHost> {
    const addr = hostname.replace(/^\[|\]$/g, "");
    const literalFamily = isIP(addr);
    if (literalFamily !== 0) {
      this.assertPublicAddress(addr);
      return { address: addr, family: literalFamily as 4 | 6 };
    }

    let records: { address: string }[];
    try {
      records = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new BadRequestException("Unable to resolve WebDAV host");
    }

    if (!records.length) {
      throw new BadRequestException("Unable to resolve WebDAV host");
    }

    for (const record of records) {
      this.assertPublicAddress(record.address);
    }
    const selected = records[0].address;
    const family = isIP(selected);
    if (family === 0) {
      throw new BadRequestException("Invalid WebDAV host address");
    }
    return { address: selected, family: family as 4 | 6 };
  }

  private assertPublicAddress(address: string) {
    const addr = address.replace(/^\[|\]$/g, "");
    const version = isIP(addr);
    if (version === 0) {
      throw new BadRequestException("Invalid WebDAV host address");
    }

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
        (a === 192 && b === 0) ||
        (a === 192 && b === 0 && parts[2] === 2) ||
        (a === 192 && b === 168) ||
        (a === 198 && b === 51 && parts[2] === 100) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 203 && b === 0 && parts[2] === 113) ||
        a >= 224;
      if (isPrivate) {
        throw new BadRequestException(
          "Private or reserved WebDAV addresses are not allowed",
        );
      }
      return;
    }

    // IPv6
    const lower = addr.toLowerCase();
    const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mappedV4) {
      this.assertPublicAddress(mappedV4[1]);
      return;
    }

    const isPrivate =
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("2001:db8") ||
      lower.startsWith("ff");
    if (isPrivate) {
      throw new BadRequestException(
        "Private or reserved WebDAV addresses are not allowed",
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

  private requestWebDav(
    target: ValidatedWebDavTarget,
    options: WebDavRequestOptions,
  ): Promise<WebDavUpstreamResponse> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        target.url,
        {
          method: options.method,
          headers: options.headers,
          lookup: (_hostname, _options, callback) => {
            callback(null, target.address, target.family);
          },
          timeout: WEBDAV_REQUEST_TIMEOUT_MS,
        },
        (stream) => {
          resolve({
            status: stream.statusCode || 0,
            headers: stream.headers,
            stream,
            text: () => this.readStreamText(stream),
          });
        },
      );

      req.on("timeout", () =>
        req.destroy(new Error("WebDAV upstream request timed out")),
      );
      req.on("error", reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  private readStreamText(stream: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      stream.on("error", reject);
    });
  }

  private isSuccessfulStatus(status: number): boolean {
    return status >= 200 && status < 300;
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) return value[0];
    return value;
  }
}
