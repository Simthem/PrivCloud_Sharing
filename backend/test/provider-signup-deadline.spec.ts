import assert from "node:assert/strict";
import { AuthService } from "src/auth/auth.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("provider sign-up deadline");

function service() {
  const rows = new Map<string, Record<string, unknown>>();
  const mailed: string[] = [];
  const transaction = {
    user: {
      count: async () => 1,
      // The insert trigger gives a deadline to any account created without one.
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `user-${rows.size}`,
          ...data,
          emailVerificationRequiredAt:
            data.emailVerificationRequiredAt ??
            (data.emailVerifiedAt ? null : new Date()),
        };
        rows.set(row.id, row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => Object.assign(rows.get(where.id)!, data),
    },
  };
  const auth = Object.create(AuthService.prototype) as AuthService;
  Object.assign(auth, {
    prisma: {
      $transaction: async (work: (tx: typeof transaction) => unknown) =>
        work(transaction),
    },
    logger: { log: () => undefined },
    signUpQueue: Promise.resolve(),
    emailVerificationService: {
      isDeliveryAvailable: () => true,
      issueInTransaction: async (_tx: unknown, user: { email: string }) => {
        mailed.push(user.email);
      },
      deliverPending: async () => undefined,
    },
    assertAddressAvailable: async () => undefined,
    createRefreshToken: async () => ({
      refreshToken: "r",
      refreshTokenId: "id",
    }),
    createAccessToken: async () => "a",
  });
  return { auth, rows, mailed };
}

const signUp = (auth: AuthService, email: string, flags: boolean[]) =>
  auth.signUp(
    { email, username: email, password: null } as never,
    "ip",
    false,
    ...flags,
  );

testCase("an address no provider proved gets no deadline", async () => {
  const { auth, rows, mailed } = service();
  const { user } = await signUp(auth, "entra@example.test", [false, true]);
  assert.equal(rows.get(user.id)!.emailVerificationRequiredAt, null);
  assert.equal(rows.get(user.id)!.emailVerifiedAt, null);
  assert.deepEqual(mailed, []);
});

testCase("a local sign-up keeps its deadline and its link", async () => {
  const { auth, rows, mailed } = service();
  const { user } = await signUp(auth, "local@example.test", [false, false]);
  assert.ok(rows.get(user.id)!.emailVerificationRequiredAt instanceof Date);
  assert.deepEqual(mailed, ["local@example.test"]);
});

testCase("a proven provider address is verified at once", async () => {
  const { auth, rows, mailed } = service();
  const { user } = await signUp(auth, "google@example.test", [true, false]);
  assert.ok(rows.get(user.id)!.emailVerifiedAt instanceof Date);
  assert.deepEqual(mailed, []);
});

void run();
