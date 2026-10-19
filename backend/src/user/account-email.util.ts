import type { PrismaService } from "src/prisma/prisma.service";

export async function accountEmailExists(
  prisma: Pick<PrismaService, "$queryRaw">,
  email: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ present: number }[]>`
    SELECT 1 AS "present" FROM "User"
    WHERE lower("email") = ${email.toLowerCase()} LIMIT 1
  `;
  return rows.length > 0;
}
