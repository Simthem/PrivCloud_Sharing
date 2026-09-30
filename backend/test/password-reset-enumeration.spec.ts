import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AuthService } from "../src/auth/auth.service";

async function run() {
  const lookups = [
    null,
    { ldapDN: "uid=managed,dc=example,dc=com" },
    {
      id: "local-user",
      email: "local@example.com",
      ldapDN: null,
      resetPasswordToken: null,
    },
  ];
  const writes: string[] = [];
  let storedToken = "";
  let deliveredToken = "";
  const service = Object.assign(Object.create(AuthService.prototype), {
    config: { get: () => false },
    prisma: {
      user: { findFirst: async () => lookups.shift() },
      resetPasswordToken: {
        delete: async () => writes.push("delete"),
        create: async ({ data }: { data: { token: string } }) => {
          storedToken = data.token;
          writes.push("create");
          return { token: "unexpected" };
        },
      },
    },
    emailService: {
      sendResetPasswordEmail: async (_email: string, token: string) => {
        deliveredToken = token;
        writes.push("email");
        throw new Error("SMTP unavailable");
      },
    },
    logger: { warn: () => writes.push("warn") },
  }) as AuthService;

  await service.requestResetPassword("unknown@example.com");
  await service.requestResetPassword("managed@example.com");

  assert.deepEqual(writes, []);
  await service.requestResetPassword("local@example.com");
  assert.deepEqual(writes, ["create", "email", "warn"]);
  assert.equal(deliveredToken.length, 43);
  assert.equal(
    storedToken,
    crypto.createHash("sha256").update(deliveredToken).digest("hex"),
  );
  console.log(
    "ok - password reset does not reveal unknown or externally managed accounts",
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
