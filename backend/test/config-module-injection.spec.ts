import "reflect-metadata";
import assert from "node:assert/strict";
import { MODULE_METADATA } from "@nestjs/common/constants";
import type { Provider } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigModule } from "src/config/config.module";
import { ConfigController } from "src/config/config.controller";
import { ConfigService } from "src/config/config.service";
import { LogoService } from "src/config/logo.service";
import { EmailModule } from "src/email/email.module";
import { EmailService } from "src/email/email.service";
import { EmailOutboxService } from "src/email/email-outbox.service";
import { PrismaModule } from "src/prisma/prisma.module";
import { PrismaService } from "src/prisma/prisma.service";
import { StepUpService } from "src/auth/stepUp.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("config module injection");

testCase(
  "ConfigController resolves the exported StepUpService without a database",
  async () => {
    const originalConfigProviders: Provider[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ConfigModule,
    );
    const originalEmailProviders = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      EmailModule,
    );
    const originalPrismaProviders = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PrismaModule,
    );
    const config = { get: () => undefined, list: async () => [] };
    const replacements = new Map<unknown, unknown>([
      ["CONFIG_VARIABLES", []],
      [ConfigService, config],
      [LogoService, {}],
    ]);

    // Keep the real module imports, exports, controller and step-up provider.
    // Replace only dependencies that access storage or external services.
    Reflect.defineMetadata(
      MODULE_METADATA.PROVIDERS,
      originalConfigProviders.map((provider) => {
        const token = "provide" in provider ? provider.provide : provider;
        return replacements.has(token)
          ? { provide: token, useValue: replacements.get(token) }
          : provider;
      }),
      ConfigModule,
    );
    Reflect.defineMetadata(
      MODULE_METADATA.PROVIDERS,
      [
        { provide: EmailService, useValue: {} },
        { provide: EmailOutboxService, useValue: {} },
      ],
      EmailModule,
    );
    Reflect.defineMetadata(
      MODULE_METADATA.PROVIDERS,
      [{ provide: PrismaService, useValue: {} }],
      PrismaModule,
    );

    try {
      const app = await NestFactory.createApplicationContext(ConfigModule, {
        logger: false,
        abortOnError: false,
      });
      try {
        const controller = app.get(ConfigController);
        const stepUp = app.get(StepUpService);
        assert.ok(stepUp instanceof StepUpService);
        assert.equal(
          (controller as unknown as { stepUp: StepUpService }).stepUp,
          stepUp,
        );
      } finally {
        await app.close();
      }
    } finally {
      Reflect.defineMetadata(
        MODULE_METADATA.PROVIDERS,
        originalConfigProviders,
        ConfigModule,
      );
      Reflect.defineMetadata(
        MODULE_METADATA.PROVIDERS,
        originalEmailProviders,
        EmailModule,
      );
      Reflect.defineMetadata(
        MODULE_METADATA.PROVIDERS,
        originalPrismaProviders,
        PrismaModule,
      );
    }
  },
);

void run();
