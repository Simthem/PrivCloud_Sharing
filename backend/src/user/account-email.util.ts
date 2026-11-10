import { loadConfigKey } from "src/config/config-encryption";
import { findUserIdByEmail } from "src/prisma/sealed-columns";
import type { PrismaService } from "src/prisma/prisma.service";

export async function accountEmailExists(
  prisma: Pick<PrismaService, "$queryRaw" | "user">,
  email: string,
): Promise<boolean> {
  return (await findUserIdByEmail(prisma, email, loadConfigKey())) !== null;
}
