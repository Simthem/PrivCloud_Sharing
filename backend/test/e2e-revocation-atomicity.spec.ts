import assert from "node:assert/strict";
import { UserSevice } from "../src/user/user.service";

async function run() {
  const writes: string[] = [];
  let transactions = 0;
  const service = Object.assign(Object.create(UserSevice.prototype), {
    prisma: {
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        transactions++;
        return work({
          wrappedKey: { deleteMany: async () => writes.push("wrapped") },
          teamMember: { updateMany: async () => writes.push("team") },
          teamKeyRotation: {
            updateMany: async () => writes.push("rotation"),
          },
          user: { update: async () => writes.push("user") },
        });
      },
    },
  }) as UserSevice;

  await service.revokeEncryptionKeyMaterial("user-1");
  assert.equal(transactions, 1);
  assert.deepEqual(writes, ["wrapped", "team", "rotation", "user"]);
  console.log("ok - E2E key material is revoked in one transaction");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
