import {
  ClassSerializerInterceptor,
  HttpException,
  Logger,
  LogLevel,
  ValidationPipe,
} from "@nestjs/common";
import { HttpAdapterHost, NestFactory, Reflector } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import * as fs from "fs";
import { AppModule } from "./app.module";
import {
  isProbeRequest,
  PROBE_MAX_BODY_BYTES,
  validateProbeBody,
  validateProbeContentLength,
} from "./probe/probe-validation.util";
import { AbortedRequestFilter } from "./aborted-request.filter";
import {
  DATA_DIRECTORY,
  LOG_LEVEL_AVAILABLE,
  LOG_LEVEL_DEFAULT,
  LOG_LEVEL_ENV,
} from "./constants";
import {
  ANONYMOUS_MAX_UPLOAD_CHUNK_BYTES,
  AUTHENTICATED_MAX_UPLOAD_CHUNK_BYTES,
  getMaxUploadPayloadBytes,
  MAX_UPLOAD_CHUNK_BYTES,
  MIN_ENCRYPTION_CHUNK_BYTES,
} from "./file/upload-limit.util";
import { markUploadRequestStarted } from "./file/upload-timing.util";

// Suppress DEP0060 (util._extend) emitted by internal Node.js / third-party
// dependencies on Node 24+. The API is deprecated but still works; the warning
// is noise we cannot fix upstream.
const _originalEmit = process.emit.bind(process);
(process as any).emit = (event: string, ...args: any[]) => {
  if (event === "warning" && args[0]?.code === "DEP0060") {
    return false;
  }
  return _originalEmit(event, ...args);
};

// global-agent (loaded via NODE_OPTIONS --require) patches http/https.globalAgent
// but does NOT patch the native fetch() built-in de Node.js 24.
//
// IMPORTANT: In Node.js 24, the built-in fetch() uses an INTERNAL copy of
// undici.  The npm "undici" package is a SEPARATE copy.  Calling
// setGlobalDispatcher() from the npm package only affects the npm copy's
// fetch - NOT globalThis.fetch().  This broke after a Dockerfile rebuild
// because undici@latest resolved to a version with diverging internals.
//
// Fix: replace globalThis.fetch() with the npm undici's fetch() bound to
// a ProxyAgent.  This ensures ALL outgoing fetch() calls (OAuth,
// etc.) go through the forward proxy.
const proxyUrl =
  process.env.GLOBAL_AGENT_HTTPS_PROXY ||
  process.env.GLOBAL_AGENT_HTTP_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy;

if (proxyUrl) {
  try {
    const undici = require("undici");
    const dispatcher = new undici.ProxyAgent(proxyUrl);

    // Keep the old setGlobalDispatcher for any code that explicitly uses
    // undici.fetch() or undici.request() without its own dispatcher.
    undici.setGlobalDispatcher(dispatcher);

    // Replace the built-in fetch() so ALL call sites automatically proxy.
    const _nativeFetch = globalThis.fetch;
    globalThis.fetch = ((
      input: string | URL | globalThis.Request,
      init?: RequestInit,
    ) =>
      undici.fetch(input, {
        ...(init as Record<string, unknown>),
        dispatcher,
      })) as typeof globalThis.fetch;

    // SECURITY: Log only host/port - never expose proxy credentials
    const safeProxyUrl = (() => {
      try {
        const u = new URL(proxyUrl);
        u.username = "";
        u.password = "";
        return u.toString();
      } catch {
        return "[invalid URL]";
      }
    })();
    console.log(
      `[Proxy] globalThis.fetch replaced with undici.fetch -> ${safeProxyUrl}`,
    );
  } catch (err: any) {
    console.error(`[Proxy] Failed to load undici: ${err.message}`);
    console.error(
      `[Proxy] OAuth calls to external providers may fail/timeout.`,
    );
  }
}

function generateNestJsLogLevels(): LogLevel[] {
  if (LOG_LEVEL_ENV) {
    const levelIndex = LOG_LEVEL_AVAILABLE.indexOf(LOG_LEVEL_ENV as LogLevel);
    if (levelIndex === -1) {
      throw new Error(`log level ${LOG_LEVEL_ENV} unknown`);
    }

    return LOG_LEVEL_AVAILABLE.slice(levelIndex, LOG_LEVEL_AVAILABLE.length);
  } else {
    const levelIndex = LOG_LEVEL_AVAILABLE.indexOf(LOG_LEVEL_DEFAULT);
    return LOG_LEVEL_AVAILABLE.slice(levelIndex, LOG_LEVEL_AVAILABLE.length);
  }
}

async function bootstrap() {
  const logLevels = generateNestJsLogLevels();
  Logger.log(`Showing ${logLevels.join(", ")} messages`);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: logLevels,
    rawBody: true,
    // Disable NestJS internal body parsers (default limit = 100 KB).
    // We register our own below via useBodyParser() with proper limits.
    // Without this, the internal 100 KB json parser rejects large JSON
    // bodies (e.g. base64-encoded PDFs in E2E finalization) with 413
    // before the custom 50 MB parser ever runs.
    bodyParser: false,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors) => {
        const logger = new Logger("ValidationPipe");
        logger.warn(
          `Validation failed: ${JSON.stringify(
            errors.map((e) => ({
              property: e.property,
              constraints: e.constraints,
              children: e.children?.map((c) => ({
                property: c.property,
                constraints: c.constraints,
              })),
            })),
          )}`,
        );
        const messages = errors
          .map((e) => {
            const own = Object.values(e.constraints || {});
            const nested = (e.children || []).flatMap((c) =>
              Object.values(c.constraints || {}),
            );
            return [...own, ...nested];
          })
          .flat();
        return new HttpException(
          { statusCode: 400, message: messages, error: "Bad Request" },
          400,
        );
      },
    }),
  );
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  app.useGlobalFilters(
    new AbortedRequestFilter(app.get(HttpAdapterHost).httpAdapter),
  );

  // Timestamp the streaming upload as soon as its headers reach Express.
  // S3FileService later reports requestToS3Ms, which includes parsers, guards,
  // authorization, share validation, DB work, multipart init and semaphore wait.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (
      req.method === "POST" &&
      req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ===
        "application/vnd.privcloud.chunk"
    ) {
      markUploadRequestStarted(req);
    }
    next();
  });

  // Reject oversized or ambiguous bandwidth probes before any body parser
  // allocates memory. A dedicated raw parser then applies the same 8 MB ceiling,
  // and the post-parser check verifies that the body really matches the
  // declared length and media type.
  const validatedProbeLengths = new WeakMap<Request, number>();
  const rejectProbe = (
    res: Response,
    validation: {
      statusCode: 400 | 411 | 413 | 415;
      message: string;
    },
  ) =>
    res.status(validation.statusCode).json({
      statusCode: validation.statusCode,
      message: validation.message,
      error:
        validation.statusCode === 413
          ? "Payload Too Large"
          : validation.statusCode === 415
            ? "Unsupported Media Type"
            : validation.statusCode === 411
              ? "Length Required"
              : "Bad Request",
    });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isProbeRequest(req)) return next();

    const validation = validateProbeContentLength(
      req.headers["content-length"],
    );
    if (validation.ok === false) {
      rejectProbe(res, validation);
      return;
    }

    validatedProbeLengths.set(req, validation.length);
    next();
  });
  app.useBodyParser("raw", {
    type: (req) => isProbeRequest(req as Request),
    limit: PROBE_MAX_BODY_BYTES,
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isProbeRequest(req)) return next();

    const declaredLength = validatedProbeLengths.get(req);
    const validation =
      declaredLength === undefined
        ? validateProbeContentLength(undefined)
        : validateProbeBody(
            req.body,
            declaredLength,
            req.headers["content-type"],
          );
    if (validation.ok === false) {
      rejectProbe(res, validation);
      return;
    }
    next();
  });

  // Register body parsers via NestJS's useBodyParser() so the rawBody
  // wrapper preserves raw-body access for endpoints that validate signed data.
  // SECURITY: Limit JSON/urlencoded to 10MB to mitigate DoS via large payloads.
  // No legitimate JSON payload should exceed this.
  app.useBodyParser("json", { limit: "10mb" });
  app.useBodyParser("urlencoded", { limit: "2mb", extended: true });

  // Adaptive chunk sizing: the frontend sends chunks based on measured
  // bandwidth. Express buffers the entire raw body in RAM, so production
  // deployments can lower UPLOAD_MAX_CHUNK_BYTES on small VMs.
  // E2E transport chunks contain independently authenticated records, each
  // adding a 12-byte IV and a 16-byte GCM tag.
  // `share.chunkSize` is a legacy/adaptive preference, not permission to
  // widen the process safety ceiling. The controller separately applies the
  // lower anonymous/authenticated instance profile.
  const rawPlainLimit = MAX_UPLOAD_CHUNK_BYTES;
  const rawLimit =
    getMaxUploadPayloadBytes(
      rawPlainLimit,
      rawPlainLimit,
      MIN_ENCRYPTION_CHUNK_BYTES,
    ) + 128;
  new Logger("UploadLimits").log(
    `hard=${MAX_UPLOAD_CHUNK_BYTES} anonymous=${ANONYMOUS_MAX_UPLOAD_CHUNK_BYTES} ` +
      `authenticated=${AUTHENTICATED_MAX_UPLOAD_CHUNK_BYTES} ` +
      `rawPayload=${rawLimit}`,
  );
  app.useBodyParser("raw", {
    type: (req) => {
      if (isProbeRequest(req as Request)) return false;
      return (
        req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ===
        "application/octet-stream"
      );
    },
    limit: rawLimit,
  });

  app.use(cookieParser());

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: false, // Handled by upstream nginx
      hsts: { maxAge: 31536000, includeSubDomains: true },
    }),
  );

  // Trust only the immediate upstream proxy (nginx)
  app.set("trust proxy", 1);

  await fs.promises.mkdir(`${DATA_DIRECTORY}/uploads/_temp`, {
    recursive: true,
  });

  app.setGlobalPrefix("api");

  // Setup Swagger in development mode only
  if (process.env.NODE_ENV === "development") {
    const config = new DocumentBuilder()
      .setTitle("OttrBox API")
      .setVersion("1.0")
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api/swagger", app, document);
  }

  await app.listen(
    parseInt(process.env.BACKEND_PORT || process.env.PORT || "8080"),
  );

  // Fix Caddy <-> Node.js keepalive race condition (502 errors).
  //
  // Scenario: Caddy reuses a keepalive TCP connection that was idle for
  // slightly more than Node.js's keepAliveTimeout (default: 5 s). Node.js
  // has already sent FIN / RST on that socket, but Caddy hasn't received
  // it yet when it dispatches the next request -> "use of closed network
  // connection" -> Caddy returns 502.
  //
  // Fix: set keepAliveTimeout well above Caddy's backend idle timeout
  // (Caddy default is 30 s; we set 65 s so Node.js always outlasts Caddy).
  // headersTimeout must be strictly greater than keepAliveTimeout to avoid
  // a secondary race where Node.js closes mid-headers.
  //
  // Reference: https://nodejs.org/api/http.html#serverkeepalivetimeout
  const httpServer = app.getHttpServer() as import("http").Server;
  httpServer.keepAliveTimeout = 65_000; // 65 s  (> Caddy's 30 s default)
  httpServer.headersTimeout = 66_000; // 66 s  (> keepAliveTimeout)

  const logger = new Logger("UnhandledAsyncError");
  process.on("unhandledRejection", (e) => logger.error(e));
}
bootstrap();
