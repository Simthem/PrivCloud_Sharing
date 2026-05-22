import {
  ClassSerializerInterceptor,
  HttpException,
  Logger,
  LogLevel,
  ValidationPipe,
} from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import * as fs from "fs";
import { AppModule } from "./app.module";
import { AbortedRequestFilter } from "./aborted-request.filter";
import { ConfigService } from "./config/config.service";
import {
  DATA_DIRECTORY,
  LOG_LEVEL_AVAILABLE,
  LOG_LEVEL_DEFAULT,
  LOG_LEVEL_ENV,
} from "./constants";

// Suppress DEP0060 (util._extend) emitted by internal Node.js / third-party
// dependencies on Node 24+. The API is deprecated but still works; the warning
// is noise we cannot fix upstream.
const _originalEmit = process.emit.bind(process);
(process as any).emit = (event: string, ...args: any[]) => {
  if (
    event === "warning" &&
    args[0]?.code === "DEP0060"
  ) {
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
// a ProxyAgent.  This ensures ALL outgoing fetch() calls (hCaptcha, OAuth,
// etc.) go through the forward proxy.
const proxyUrl =
  process.env.GLOBAL_AGENT_HTTP_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy;

if (proxyUrl) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undici = require("undici");
    const dispatcher = new undici.ProxyAgent(proxyUrl);

    // Keep the old setGlobalDispatcher for any code that explicitly uses
    // undici.fetch() or undici.request() without its own dispatcher.
    undici.setGlobalDispatcher(dispatcher);

    // Replace the built-in fetch() so ALL call sites automatically proxy.
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = ((
      input: string | URL | globalThis.Request,
      init?: RequestInit,
    ) =>
      undici.fetch(input, {
        ...(init as Record<string, unknown>),
        dispatcher,
      })) as typeof globalThis.fetch;

    console.log(`[Proxy] globalThis.fetch replaced with undici.fetch -> ${proxyUrl}`);
  } catch (err: any) {
    console.error(`[Proxy] Failed to load undici: ${err.message}`);
    console.error(`[Proxy] OAuth / hCaptcha calls to external providers may fail/timeout.`);
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
  app.useGlobalFilters(new AbortedRequestFilter());

  const config = app.get<ConfigService>(ConfigService);

  // Register body parsers via NestJS's useBodyParser() so the rawBody
  app.useBodyParser("json", { limit: "50mb" });
  app.useBodyParser("urlencoded", { limit: "50mb", extended: true });

  // Adaptive chunk sizing: the frontend may send chunks up to 200 MB
  // based on measured bandwidth.  Express buffers the entire raw body
  // in RAM, so ensure the VM has ≥ 4 GB RAM and Node is launched with
  // --max-old-space-size=3072 to handle concurrent 200 MB chunks.
  // E2E encrypted chunks add 28 bytes (12 IV + 16 GCM tag).
  const chunkSize = config.get("share.chunkSize");
  const rawLimit = Math.max(chunkSize, 200_000_000) + 128;
  app.useBodyParser("raw", {
    type: "application/octet-stream",
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
  // it yet when it dispatches the next request → "use of closed network
  // connection" → Caddy returns 502.
  //
  // Fix: set keepAliveTimeout well above Caddy's backend idle timeout
  // (Caddy default is 30 s; we set 65 s so Node.js always outlasts Caddy).
  // headersTimeout must be strictly greater than keepAliveTimeout to avoid
  // a secondary race where Node.js closes mid-headers.
  //
  // Reference: https://nodejs.org/api/http.html#serverkeepalivetimeout
  const httpServer = app.getHttpServer() as import("http").Server;
  httpServer.keepAliveTimeout = 65_000; // 65 s  (> Caddy's 30 s default)
  httpServer.headersTimeout = 66_000;   // 66 s  (> keepAliveTimeout)

  const logger = new Logger("UnhandledAsyncError");
  process.on("unhandledRejection", (e) => logger.error(e));
}
bootstrap();
