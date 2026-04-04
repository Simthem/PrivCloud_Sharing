import { Injectable, Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { DATABASE_URL, resolveDbUrl } from "../constants";

@Injectable()
export class PrismaService extends PrismaClient {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const dbPath = resolveDbUrl(DATABASE_URL);
    const adapter = new PrismaBetterSqlite3({ url: dbPath });
    super({ adapter });
    super.$connect().then(async () => {
      this.logger.log(`Connected to the database (${dbPath})`);
      // Startup integrity check: log E2E key and reverse share counts
      try {
        const users = await (this as any).$queryRawUnsafe(
          "SELECT count(*) AS c FROM User WHERE encryptionKeyHash IS NOT NULL",
        );
        const rs = await (this as any).$queryRawUnsafe(
          "SELECT count(*) AS c FROM ReverseShare",
        );
        this.logger.log(
          `DB integrity: ${users[0]?.c ?? "?"} users with E2E key, ${rs[0]?.c ?? "?"} reverse shares`,
        );
      } catch {
        // Non-blocking: table might not exist on first run
      }
    });
  }
}
