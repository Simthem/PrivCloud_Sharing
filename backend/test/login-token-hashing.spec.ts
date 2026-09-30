import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AuthService } from "../src/auth/auth.service";

async function run() {
  let storedToken = "";
  const service = Object.assign(Object.create(AuthService.prototype), {
    prisma: {
      loginToken: {
        create: async ({ data }: { data: { token: string } }) => {
          storedToken = data.token;
          return data;
        },
      },
    },
  }) as AuthService;

  const rawToken = await service.createLoginToken("user-1");
  assert.equal(rawToken.length, 43);
  assert.equal(
    storedToken,
    crypto.createHash("sha256").update(rawToken).digest("hex"),
  );
  assert.notEqual(storedToken, rawToken);
  console.log("ok - TOTP login tokens are stored only as hashes");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
