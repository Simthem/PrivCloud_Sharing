import "reflect-metadata";
import assert from "node:assert/strict";
import { AuthService } from "src/auth/auth.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("password update atomicity");

testCase("updates the password and revokes sessions in one transaction", async () => {
  const operations: string[] = [];
  let transactions = 0;
  const service = Object.create(AuthService.prototype) as AuthService;
  Object.assign(service, {
    prisma: {
      $transaction: async (work: (tx: unknown) => Promise<void>) => {
        transactions++;
        await work({
          user: {
            update: async () => {
              operations.push("password");
            },
          },
          refreshToken: {
            deleteMany: async () => {
              operations.push("sessions");
            },
          },
        });
      },
    },
  });

  await service.updatePassword(
    { id: "user-1", password: null } as never,
    "a-new-strong-password",
  );
  assert.equal(transactions, 1);
  assert.deepEqual(operations, ["password", "sessions"]);
});

void run();
