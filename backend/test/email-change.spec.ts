import "reflect-metadata";
import assert from "node:assert/strict";
import { ValidationPipe } from "@nestjs/common";
import { User } from "@prisma/client";
import {
  EmailChangeDTO,
  EmailChangeTokenDTO,
} from "src/auth/dto/emailChange.dto";
import { UserController } from "src/user/user.controller";
import { UserSevice } from "src/user/user.service";
import { OAuthReauthService } from "src/auth/oauthReauth.service";
import { OAuthController } from "src/oauth/oauth.controller";
import { createUnitTestRunner } from "./unit-test";
import { createTestCredentials } from "./test-credentials";

const fixtureCredentials = createTestCredentials();

const { testCase, run } = createUnitTestRunner(
  "email change inputs and proof separation",
);

testCase("password length remains compatible with sign-in", async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  for (const length of [257, 1024]) {
    const input = (await pipe.transform(
      {
        email: fixtureCredentials.nextEmail,
        password: fixtureCredentials.character.repeat(length),
      },
      { type: "body", metatype: EmailChangeDTO },
    )) as EmailChangeDTO;
    assert.equal(input.password?.length, length);
  }
  await assert.rejects(
    pipe.transform(
      {
        email: fixtureCredentials.nextEmail,
        password: fixtureCredentials.character.repeat(1025),
      },
      { type: "body", metatype: EmailChangeDTO },
    ),
  );
  for (const token of [
    "",
    fixtureCredentials.character.repeat(42),
    fixtureCredentials.character.repeat(44),
    "/".repeat(43),
  ]) {
    await assert.rejects(
      pipe.transform(
        { token },
        { type: "body", metatype: EmailChangeTokenDTO },
      ),
    );
  }
});

testCase("profile writes cannot change or restore an old email", async () => {
  const updates: unknown[] = [];
  const controller = Object.create(UserController.prototype) as UserController;
  Object.assign(controller, {
    userService: {
      update: async (_id: string, profile: unknown) => {
        updates.push(profile);
        return { id: "u", email: fixtureCredentials.currentEmail };
      },
    },
  });
  const user = { id: "u", email: fixtureCredentials.currentEmail } as User;
  await assert.rejects(
    controller.updateCurrentUser(user, { email: fixtureCredentials.nextEmail }),
  );
  await controller.updateCurrentUser(user, {
    email: user.email,
    username: "new-name",
  });
  assert.deepEqual(updates, [{ username: "new-name" }]);
});

testCase(
  "EMAIL intent and proof cannot authorize password or second-factor changes",
  async () => {
    type ProofRow = {
      tokenHash: string;
      userId: string;
      provider: string;
      stage: string;
      purpose: string;
      expiresAt: Date;
      usedAt: Date | null;
    };
    const rows = new Map<string, ProofRow>();
    const service = new OAuthReauthService({
      oAuthReauthToken: {
        create: async ({ data }: { data: Omit<ProofRow, "usedAt"> }) => {
          rows.set(data.tokenHash, { ...data, usedAt: null });
        },
        findUnique: async ({ where }: { where: { tokenHash: string } }) =>
          rows.get(where.tokenHash) ?? null,
        updateMany: async ({
          where,
          data,
        }: {
          where: { tokenHash: string };
          data: { usedAt: Date };
        }) => {
          const row = rows.get(where.tokenHash);
          if (!row || row.usedAt) return { count: 0 };
          row.usedAt = data.usedAt;
          return { count: 1 };
        },
        deleteMany: async () => ({ count: 0 }),
      },
    } as never);
    const intent = await service.startIntent("u", "oidc", "EMAIL");
    assert.deepEqual(await service.consumeIntent(intent, "oidc"), {
      userId: "u",
      purpose: "EMAIL",
    });
    const proof = await service.issueProof("u", "oidc", "EMAIL");
    assert.equal(await service.consumeProof(proof, "u", "PASSWORD"), false);
    assert.equal(await service.consumeProof(proof, "u", "TOTP"), false);
    assert.equal(await service.consumeProof(proof, "foreign", "EMAIL"), false);
    assert.equal(await service.consumeProof(proof, "u", "EMAIL"), true);
    assert.equal(await service.consumeProof(proof, "u", "EMAIL"), false);
  },
);

testCase(
  "email OAuth confirmation requires a recent provider sign-in",
  async () => {
    const controller = Object.create(
      OAuthController.prototype,
    ) as OAuthController;
    const issued: string[] = [];
    const flow = controller as unknown as {
      completeReauth: (
        provider: string,
        intent: string,
        identity: { providerId: string; authTime?: number },
        response: unknown,
      ) => Promise<void>;
    };
    Object.assign(controller, {
      oauthReauth: {
        consumeIntent: async () => ({ userId: "u", purpose: "EMAIL" }),
        issueProof: async (
          _user: string,
          _provider: string,
          purpose: string,
        ) => {
          issued.push(purpose);
          return fixtureCredentials.proof;
        },
      },
      oauthService: { isLinked: async () => true },
      config: {
        get: (key: string) =>
          key === "general.appUrl" ? "https://example.test" : true,
      },
    });
    let destination = "";
    const response = {
      cookie: () => undefined,
      redirect: (url: string) => {
        destination = url;
      },
    };
    await assert.rejects(
      flow.completeReauth(
        "oidc",
        "intent",
        { providerId: "subject" },
        response,
      ),
    );
    await assert.rejects(
      flow.completeReauth(
        "oidc",
        "intent",
        { providerId: "subject", authTime: 1 },
        response,
      ),
    );
    assert.deepEqual(issued, []);
    await flow.completeReauth(
      "oidc",
      "intent",
      { providerId: "subject", authTime: Math.floor(Date.now() / 1000) },
      response,
    );
    assert.deepEqual(issued, ["EMAIL"]);
    assert.equal(destination, "https://example.test/account?emailReauth=1");
  },
);

function administeredAccount() {
  const user = {
    id: "u",
    username: "user",
    email: fixtureCredentials.currentEmail,
    password: fixtureCredentials.passwordHash,
    isAdmin: false,
    emailVerifiedAt: new Date(),
    emailVerificationRequiredAt: new Date(),
  } as User;
  const purged: string[] = [];
  const logs: string[] = [];
  const table = (name: string) => ({
    deleteMany: async ({ where }: { where: { userId: string } }) => {
      purged.push(`${name}:${where.userId}`);
    },
  });
  const tx = {
    user: {
      update: async ({ data }: { data: Partial<User> }) =>
        Object.assign(user, data),
    },
    resetPasswordToken: table("reset"),
    emailChangeRequest: table("email-change"),
    emailVerificationToken: table("verification"),
    refreshToken: table("session"),
    loginToken: table("sign-in"),
  };
  const service = Object.create(UserSevice.prototype) as UserSevice;
  Object.assign(service, {
    prisma: {
      user: { ...tx.user, findUnique: async () => ({ ...user }) },
      $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
    },
    emailVerificationService: {
      isDeliveryAvailable: () => true,
      issueAndSend: async () => undefined,
    },
    logger: { warn: (line: string) => logs.push(line) },
  });
  return { user, service, purged, logs };
}

testCase(
  "administrators change their own email and password with proof only",
  async () => {
    const a = administeredAccount();
    await assert.rejects(
      a.service.update("u", { email: fixtureCredentials.nextEmail }, "u"),
      /account settings/,
    );
    await assert.rejects(
      a.service.update(
        "u",
        { password: fixtureCredentials.updatedPassword },
        "u",
      ),
      /account settings/,
    );
    assert.equal(a.user.email, fixtureCredentials.currentEmail);
    assert.equal(a.user.password, fixtureCredentials.passwordHash);
    // The edit form always resends the unchanged address.
    await a.service.update(
      "u",
      {
        email: fixtureCredentials.currentEmail,
        username: fixtureCredentials.username,
      },
      "u",
    );
    assert.equal(a.user.username, fixtureCredentials.username);
    assert.deepEqual(a.purged, []);
    assert.deepEqual(a.logs, []);

    const totp: string[] = [];
    const controller = Object.create(
      UserController.prototype,
    ) as UserController;
    const confirmed: string[] = [];
    Object.assign(controller, {
      authTotpService: {
        adminDisableTotp: async (id: string) => totp.push(id),
      },
      stepUp: {
        consume: async (_request: unknown, _admin: unknown, scope: string) => {
          confirmed.push(scope);
        },
      },
      logger: { warn: () => undefined },
    });
    const admin = { id: "admin" } as User;
    const request = { cookies: {} } as never;
    await assert.rejects(
      controller.adminDisableTotp("admin", admin, request),
      /account settings/,
    );
    await controller.adminDisableTotp("u", admin, request);
    assert.deepEqual(totp, ["u"]);
    assert.deepEqual(confirmed, ["user.totp.reset:u"]);
  },
);

testCase(
  "an administrator's change revokes links and sessions of the old credentials",
  async () => {
    const address = administeredAccount();
    await address.service.update(
      "u",
      { email: fixtureCredentials.nextEmail },
      "admin",
    );
    assert.equal(address.user.email, fixtureCredentials.nextEmail);
    assert.deepEqual(address.purged, [
      "reset:u",
      "email-change:u",
      "verification:u",
    ]);
    assert.deepEqual(address.logs, [
      "Administrator admin changed the email address of user u",
    ]);
    const password = administeredAccount();
    await password.service.update(
      "u",
      { password: fixtureCredentials.updatedPassword },
      "admin",
    );
    assert.deepEqual(password.purged, ["reset:u", "session:u", "sign-in:u"]);
    assert.deepEqual(password.logs, [
      "Administrator admin changed the password of user u",
    ]);
    const profile = administeredAccount();
    await profile.service.update("u", {
      username: fixtureCredentials.username,
    });
    assert.deepEqual(profile.purged, []);
  },
);

testCase("a null password or address is refused, not written", async () => {
  const a = administeredAccount();
  for (const change of [{ password: null }, { email: null }]) {
    for (const actor of ["admin", "u"]) {
      await assert.rejects(
        a.service.update("u", change as never, actor),
        /cannot be removed/,
      );
    }
  }
  assert.equal(a.user.password, fixtureCredentials.passwordHash);
  assert.deepEqual(a.purged, []);
});

testCase(
  "administrator rights granted or revoked name who did it",
  async () => {
    const a = administeredAccount();
    await a.service.update("u", { isAdmin: true }, "admin");
    await a.service.update("u", { isAdmin: true }, "admin");
    await a.service.update("u", { isAdmin: false }, "admin");
    assert.deepEqual(a.logs, [
      "Administrator admin granted administrator rights to user u",
      "Administrator admin revoked administrator rights of user u",
    ]);
    const calls: unknown[][] = [];
    const controller = Object.create(
      UserController.prototype,
    ) as UserController;
    Object.assign(controller, {
      userService: {
        get: async () => ({
          id: "u",
          email: fixtureCredentials.currentEmail,
          isAdmin: false,
        }),
        update: async (...args: unknown[]) => {
          calls.push(args);
          return { id: "u", email: fixtureCredentials.currentEmail };
        },
      },
    });
    await controller.update(
      "u",
      { username: fixtureCredentials.username },
      { id: "admin" } as User,
      { cookies: {} } as never,
    );
    assert.deepEqual(calls, [
      ["u", { username: fixtureCredentials.username }, "admin"],
    ]);
  },
);

void run();
