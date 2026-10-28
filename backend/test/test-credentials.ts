import { randomBytes, randomInt } from "node:crypto";

export function createTestCredentials() {
  const token = () => randomBytes(32).toString("base64url");
  const email = () => randomBytes(12).toString("hex") + "@example.test";
  const code = randomInt(0, 1_000_000);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return {
    password: token(),
    incorrectPassword: token(),
    updatedPassword: token(),
    replacementPassword: token(),
    anotherPassword: token(),
    resetPassword: token(),
    passwordHash: token(),
    updatedPasswordHash: token(),
    totpSecret: Array.from(
      randomBytes(32),
      (value) => alphabet[value & 31],
    ).join(""),
    code: String(code).padStart(6, "0"),
    incorrectCode: String((code + 1) % 1_000_000).padStart(6, "0"),
    clientSecret: token(),
    accessToken: token(),
    authorizationCode: token(),
    idToken: token(),
    nonce: token(),
    incorrectNonce: token(),
    proof: token(),
    loginToken: token(),
    refreshToken: token(),
    username: randomBytes(12).toString("hex"),
    currentEmail: email(),
    nextEmail: email(),
    otherEmail: email(),
    adminEmail: email(),
    memberEmail: email(),
    otherAdminEmail: email(),
    identityEmail: email(),
    character: randomBytes(1).toString("hex").slice(0, 1),
  };
}
