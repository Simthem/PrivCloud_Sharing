import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { DATABASE_URL, resolveDbUrl } from "../constants";

type SqliteColumn = {
  name: string;
};

type SqliteCount = {
  c: number | bigint;
};

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);
  private readonly dbPath: string;

  constructor() {
    const dbPath = resolveDbUrl(DATABASE_URL);
    const adapter = new PrismaBetterSqlite3({ url: dbPath });
    super({ adapter });
    this.dbPath = dbPath;
  }

  async onModuleInit() {
    await super.$connect();
    this.logger.log(`Connected to the database (${this.dbPath})`);
    await this.ensureSignatureDocumentCompatibilityColumns();
    await this.logStartupIntegrity();
  }

  private async logStartupIntegrity() {
    try {
      const users = await this.$queryRawUnsafe<SqliteCount[]>(
        "SELECT count(*) AS c FROM User WHERE encryptionKeyHash IS NOT NULL",
      );
      const rs = await this.$queryRawUnsafe<SqliteCount[]>(
        "SELECT count(*) AS c FROM ReverseShare",
      );
      this.logger.log(
        `DB integrity: ${users[0]?.c ?? "?"} users with E2E key, ${rs[0]?.c ?? "?"} reverse shares`,
      );
    } catch {
      // Non-blocking: table might not exist on first run
    }
  }

  private async ensureSignatureDocumentCompatibilityColumns() {
    const documentColumns = await this.$queryRawUnsafe<SqliteColumn[]>(
      'PRAGMA table_info("SignatureDocument")',
    );
    if (documentColumns.length === 0) return;

    const columnNames = new Set(documentColumns.map((column) => column.name));
    const compatibilityColumns = [
      {
        name: "title",
        sql: 'ALTER TABLE "SignatureDocument" ADD COLUMN "title" TEXT NOT NULL DEFAULT \'\'',
      },
      {
        name: "fileKey",
        sql: 'ALTER TABLE "SignatureDocument" ADD COLUMN "fileKey" TEXT NOT NULL DEFAULT \'\'',
      },
      {
        name: "ownerId",
        sql: 'ALTER TABLE "SignatureDocument" ADD COLUMN "ownerId" TEXT NOT NULL DEFAULT \'\'',
      },
    ];

    for (const column of compatibilityColumns) {
      if (columnNames.has(column.name)) continue;

      this.logger.warn(
        `SignatureDocument.${column.name} column missing; adding compatibility column.`,
      );
      await this.$executeRawUnsafe(column.sql);
    }
  }
}
