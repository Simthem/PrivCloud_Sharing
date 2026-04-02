import {
  ClassSerializerInterceptor,
  Logger,
  LogLevel,
  ValidationPipe,
} from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import * as bodyParser from "body-parser";
import * as cookieParser from "cookie-parser";
import { NextFunction, Request, Response } from "express";
import * as fs from "fs";
import { AppModule } from "./app.module";
import { ConfigService } from "./config/config.service";
import {
  DATA_DIRECTORY,
  LOG_LEVEL_AVAILABLE,
  LOG_LEVEL_DEFAULT,
  LOG_LEVEL_ENV,
} from "./constants";

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
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  const config = app.get<ConfigService>(ConfigService);

  app.use((req: Request, res: Response, next: NextFunction) => {
    const chunkSize = config.get("share.chunkSize");
    // E2E encrypted chunks are chunkSize + 28 bytes (12 IV + 16 GCM tag).
    // Add a small margin so encrypted uploads don't hit the limit.
    const limit = chunkSize + 128;
    bodyParser.raw({
      type: "application/octet-stream",
      limit: `${limit}B`,
    })(req, res, next);
  });

  app.use(cookieParser());
  app.set("trust proxy", true);

  await fs.promises.mkdir(`${DATA_DIRECTORY}/uploads/_temp`, {
    recursive: true,
  });

  app.setGlobalPrefix("api");

  // Setup Swagger in development mode
  if (process.env.NODE_ENV == "development") {
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

  const logger = new Logger("UnhandledAsyncError");
  process.on("unhandledRejection", (e) => logger.error(e));
}
bootstrap();
