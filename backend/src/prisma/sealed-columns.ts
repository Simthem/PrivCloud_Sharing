import { Logger } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  isFullMode,
  openAccountSecret,
  openToken,
  SECRET_FIELDS,
  sealLookupValue,
  sealToken,
  TOKEN_FIELDS,
  TOKEN_PREFIX,
  tokenCandidates,
  type TokenKind,
} from "../config/account-secrets";
import {
  isDecryptMode,
  openValue,
  sealValue,
  SEALED_PREFIX,
} from "../config/config-encryption";
import { createHmac } from "crypto";

type Kind = "lookup" | "text";
type Plain = Record<string, unknown>;
type Column = { name: string; kind: Kind };

const L: Kind = "lookup";
const T: Kind = "text";
const CATEGORY = "column";
const BATCH_SIZE = 500;
const P2025 = "P2025";

// Lookup columns stay searchable by equality: a same value seals alike.
export const SEALED_COLUMNS: Record<string, Record<string, Kind>> = {
  User: { email: L, username: L, ldapDN: L },
  EmailVerificationToken: { email: L },
  EmailChangeRequest: { oldEmail: L, newEmail: L },
  Share: { name: L, description: T, senderName: L, senderEmail: L },
  ShareRecipient: { email: L },
  File: { name: L, relativePath: L },
  ReverseShare: { name: L },
  BridgeUploadToken: { label: L },
  SignatureDocument: { fileName: L, title: L, message: T },
  SignatureRecipient: {
    email: L,
    name: L,
    rejectionReason: T,
    signingIp: L,
    signingUserAgent: L,
  },
  SigningPasskey: { label: L },
  SignatureField: { label: L },
  SignatureAuditEvent: { ipAddress: L, userAgent: L, metadata: T },
  Team: {
    name: L,
    slug: L,
    description: T,
  },
  TeamFolder: { name: L, description: T },
  TeamFile: { name: L },
  TeamAccessLog: {
    actorEmail: L,
    actorName: L,
    ipAddress: L,
    userAgent: L,
    fileName: L,
    metadata: T,
  },
  TeamAuditReport: { recipientEmails: T },
  TeamKeyRotation: { errorMessage: T },
  TeamInvitation: { email: L },
  TeamGuestLink: { label: L },
  TeamExternalSeat: { email: L, displayName: L },
  TeamNotification: { title: L, metadata: T },
  TeamFileRequest: { subject: L, note: T },
  TeamExternalIssuance: {
    contractorEmail: L,
    contractorName: L,
    issuerEmail: L,
    manifest: T,
  },
  TeamExternalAuditEvent: { actorEmail: L },
};

const PRIMARY_KEYS: Record<string, string> = {
  EmailVerificationToken: "tokenHash",
};

// Values a CHECK constraint requires verbatim, they carry nothing to hide.
const PINNED_VALUES: Record<string, RegExp> = {
  "File.name": /^encrypted-file-[0-9a-fA-F]{8}$/,
  "TeamFileRequest.subject": /^$/,
};

const models = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name,
    new Map(model.fields.map((field) => [field.name, field])),
  ]),
);

const relationOf = (model: string, field: string) => {
  const definition = models.get(model)?.get(field);
  return definition?.kind === "object" ? definition.type : undefined;
};

const columnOf = (model: string, field: string): Column | undefined => {
  const kind = SEALED_COLUMNS[model]?.[field];
  return kind && { name: `${model}.${field}`, kind };
};

const tokenOf = (model: string, field: string) => TOKEN_FIELDS[model]?.[field];

/** A presented token also matches its sealed form, a stored one only itself. */
const tokenForms = (kind: TokenKind, value: string) =>
  value.startsWith("enc:") ? [value] : tokenCandidates(kind, value);

const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;

const sealedForm = (key: Buffer, column: Column, value: string) =>
  column.kind === "lookup"
    ? sealLookupValue(key, column.name, value)
    : sealValue(key, CATEGORY, column.name, value);

const seal = (key: Buffer, column: Column, value: string) =>
  PINNED_VALUES[column.name]?.test(value)
    ? value
    : sealedForm(key, column, value);

function open(key: Buffer, column: Column, value: string) {
  try {
    if (value.startsWith(TOKEN_PREFIX)) {
      return openToken(column.name, value);
    }
    return value.startsWith(SEALED_PREFIX)
      ? openValue(key, CATEGORY, column.name, value)
      : value;
  } catch {
    // Text that merely looks sealed: only sealed values come from this key.
    return value;
  }
}

/** Case-free lookup of an address, whatever the case it was typed in. */
export const emailFold = (key: Buffer, email: string) =>
  createHmac("sha256", key)
    .update(`email-fold\0${email.toLowerCase()}`, "utf8")
    .digest("base64url");

export async function findUserIdByEmail(
  prisma: Pick<PrismaClient, "$queryRaw" | "user">,
  email: string,
  key: Buffer | null,
): Promise<string | null> {
  const [account] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "User"
    WHERE lower("email") = ${email.toLowerCase()}
       OR "emailFold" = ${key ? emailFold(key, email) : null}
    LIMIT 1
  `;
  if (account) return account.id;
  if (/[^\x00-\x7f]/.test(email)) {
    const accounts = await prisma.user.findMany({
      select: { id: true, email: true },
    });
    return (
      accounts.find((user) => user.email.toLowerCase() === email.toLowerCase())
        ?.id ?? null
    );
  }
  return null;
}

const forms = (key: Buffer, column: Column, value: string) => [
  sealedForm(key, column, value),
  value,
];

function rewriteFilter(
  key: Buffer,
  model: string,
  field: string,
  column: Column,
  filter: unknown,
): Plain {
  if (filter === null || filter === undefined) return { [field]: filter };
  if (isPlain(filter) && filter.not === null) return { [field]: filter };
  if (column.kind === "text") {
    throw new Error(`${column.name} cannot be searched`);
  }
  if (typeof filter === "string") {
    return { [field]: { in: forms(key, column, filter) } };
  }
  if (isPlain(filter) && Object.keys(filter).length) {
    const { equals, in: list, not, notIn, mode } = filter;
    if (mode === "insensitive" && column.name === "User.email") {
      return {
        OR: [
          { emailFold: emailFold(key, equals as string) },
          { [field]: filter },
        ],
      };
    }
    if (mode === undefined && typeof equals === "string") {
      return { [field]: { in: forms(key, column, equals) } };
    }
    if (mode === undefined && Array.isArray(list)) {
      return {
        [field]: {
          in: (list as string[]).flatMap((v) => forms(key, column, v)),
        },
      };
    }
    if (mode === undefined && typeof not === "string") {
      return { [field]: { notIn: forms(key, column, not) } };
    }
    if (mode === undefined && Array.isArray(notIn)) {
      return {
        [field]: {
          notIn: (notIn as string[]).flatMap((v) => forms(key, column, v)),
        },
      };
    }
  }
  throw new Error(`${model}.${field}: unsupported filter on a sealed column`);
}

function rewriteTokenFilter(kind: TokenKind, filter: unknown): unknown {
  const forms = (list: unknown[]) =>
    list.flatMap((value) =>
      typeof value === "string" ? tokenForms(kind, value) : [value],
    );
  if (typeof filter === "string") return { in: tokenForms(kind, filter) };
  if (!isPlain(filter)) return filter;
  const { equals, in: list, not, notIn, ...rest } = filter;
  return {
    ...rest,
    ...(typeof equals === "string"
      ? { in: tokenForms(kind, equals) }
      : equals !== undefined && { equals }),
    ...(Array.isArray(list) && { in: forms(list) }),
    ...(typeof not === "string"
      ? { notIn: tokenForms(kind, not) }
      : not !== undefined && { not }),
    ...(Array.isArray(notIn) && { notIn: forms(notIn) }),
  };
}

export function rewriteWhere(key: Buffer, model: string, where: unknown) {
  if (!isPlain(where)) return where;
  const clauses: Plain[] = [];
  const result: Plain = {};
  for (const [field, value] of Object.entries(where)) {
    if (field === "AND" || field === "OR" || field === "NOT") {
      result[field] = Array.isArray(value)
        ? value.map((entry) => rewriteWhere(key, model, entry))
        : rewriteWhere(key, model, value);
      continue;
    }
    const column = columnOf(model, field);
    const relation = relationOf(model, field);
    const kind = tokenOf(model, field);
    if (kind) {
      result[field] = rewriteTokenFilter(kind, value);
    } else if (column) {
      const filter = rewriteFilter(key, model, field, column, value);
      if ("OR" in filter) clauses.push(filter);
      else Object.assign(result, filter);
    } else if (relation && isPlain(value)) {
      const quantified = ["some", "every", "none", "is", "isNot"].some(
        (name) => name in value,
      );
      result[field] = quantified
        ? Object.fromEntries(
            Object.entries(value).map(([name, inner]) => [
              name,
              rewriteWhere(key, relation, inner),
            ]),
          )
        : rewriteWhere(key, relation, value);
    } else {
      result[field] = value;
    }
  }
  if (clauses.length === 0) return result;
  return { AND: [result, ...clauses] };
}

/** The forms a unique lookup may be stored under, most likely first. */
export function uniqueVariants(
  key: Buffer,
  model: string,
  where: Plain,
  writes: boolean,
): Plain[] {
  const order = (values: string[]) => (writes ? values : [...values].reverse());
  for (const [field, value] of Object.entries(where)) {
    const kind = tokenOf(model, field);
    if (kind && typeof value === "string") {
      return order(tokenForms(kind, value)).map((stored) => ({
        ...where,
        [field]: stored,
      }));
    }
    const column = columnOf(model, field);
    if (column && typeof value === "string") {
      return order(forms(key, column, value)).map((stored) => ({
        ...where,
        [field]: stored,
      }));
    }
    if (!column && isPlain(value) && !relationOf(model, field)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        const innerColumn = columnOf(model, inner);
        if (innerColumn && typeof innerValue === "string") {
          return order(forms(key, innerColumn, innerValue)).map((stored) => ({
            ...where,
            [field]: { ...value, [inner]: stored },
          }));
        }
      }
    }
  }
  return [where];
}

function rewriteNested(
  key: Buffer,
  relation: string,
  value: Plain,
  writes: boolean,
) {
  const data = (entry: unknown) => rewriteData(key, relation, entry, writes);
  const where = (entry: unknown) => rewriteWhere(key, relation, entry);
  const many = (entry: unknown, apply: (one: unknown) => unknown) =>
    Array.isArray(entry) ? entry.map(apply) : apply(entry);
  const result: Plain = { ...value };
  if ("create" in value) result.create = many(value.create, data);
  if (isPlain(value.createMany)) {
    result.createMany = {
      ...value.createMany,
      data: many(value.createMany.data, data),
    };
  }
  if ("connectOrCreate" in value) {
    result.connectOrCreate = many(value.connectOrCreate, (entry) => ({
      ...(entry as Plain),
      create: data((entry as Plain).create),
    }));
  }
  if ("update" in value) {
    result.update = many(value.update, (entry) =>
      isPlain(entry) && "data" in entry
        ? { ...entry, data: data(entry.data) }
        : data(entry),
    );
  }
  if ("updateMany" in value) {
    result.updateMany = many(value.updateMany, (entry) => ({
      ...(entry as Plain),
      where: where((entry as Plain).where),
      data: data((entry as Plain).data),
    }));
  }
  if ("upsert" in value) {
    result.upsert = many(value.upsert, (entry) => ({
      ...(entry as Plain),
      create: data((entry as Plain).create),
      update: data((entry as Plain).update),
    }));
  }
  if ("deleteMany" in value) {
    result.deleteMany = many(value.deleteMany, where);
  }
  return result;
}

export function rewriteData(
  key: Buffer,
  model: string,
  data: unknown,
  writes: boolean,
): unknown {
  if (Array.isArray(data)) {
    return data.map((entry) => rewriteData(key, model, entry, writes));
  }
  if (!isPlain(data)) return data;
  const result: Plain = {};
  for (const [field, value] of Object.entries(data)) {
    const column = columnOf(model, field);
    const relation = relationOf(model, field);
    const kind = tokenOf(model, field);
    if (kind && writes) {
      const plain = isPlain(value) && "set" in value ? value.set : value;
      if (typeof plain === "string" && !plain.startsWith("enc:")) {
        result[field] = sealToken(kind, plain);
        continue;
      }
    }
    if (column && writes) {
      const plain = isPlain(value) && "set" in value ? value.set : value;
      if (typeof plain === "string") {
        result[field] = seal(key, column, plain);
        if (column.name === "User.email") {
          result.emailFold = emailFold(key, plain);
        }
        continue;
      }
    }
    result[field] =
      relation && isPlain(value)
        ? rewriteNested(key, relation, value, writes)
        : value;
  }
  return result;
}

function rewriteSelection(key: Buffer, model: string, selection: unknown) {
  if (!isPlain(selection)) return selection;
  const result: Plain = {};
  for (const [field, value] of Object.entries(selection)) {
    if (field === "_count" && isPlain(value) && isPlain(value.select)) {
      result[field] = {
        select: rewriteSelection(key, model, value.select),
      };
      continue;
    }
    const relation = relationOf(model, field);
    result[field] =
      relation && isPlain(value) ? rewriteArgs(key, relation, value) : value;
  }
  return result;
}

function rewriteArgs(key: Buffer, model: string, args: Plain): Plain {
  const result: Plain = { ...args };
  if ("where" in args) result.where = rewriteWhere(key, model, args.where);
  if ("select" in args) {
    result.select = rewriteSelection(key, model, args.select);
  }
  if ("include" in args) {
    result.include = rewriteSelection(key, model, args.include);
  }
  return result;
}

/** A value this key cannot open is returned as it is stored. */
function openStored(read: () => string, stored: string) {
  try {
    return read();
  } catch {
    return stored;
  }
}

export function openResult(key: Buffer, model: string, value: unknown) {
  if (Array.isArray(value)) {
    return value.map((entry): unknown => openResult(key, model, entry));
  }
  if (!isPlain(value)) return value;
  const result: Plain = {};
  for (const [field, inner] of Object.entries(value)) {
    const column = columnOf(model, field);
    const relation = relationOf(model, field);
    const kind = tokenOf(model, field);
    const owner = SECRET_FIELDS[model]?.[field];
    if (kind && typeof inner === "string") {
      result[field] = openStored(() => openToken(kind, inner), inner);
    } else if (owner && typeof inner === "string") {
      const ownerId = value[owner];
      result[field] =
        typeof ownerId === "string"
          ? openStored(
              () =>
                openAccountSecret(
                  ownerId,
                  field as Parameters<typeof openAccountSecret>[1],
                  inner,
                ),
              inner,
            )
          : inner;
    } else if (column && typeof inner === "string") {
      result[field] = open(key, column, inner);
    } else if (relation) {
      result[field] = openResult(key, relation, inner);
    } else {
      result[field] = inner;
    }
  }
  return result;
}

const UNIQUE_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "delete",
]);

type Run = (args: unknown) => Promise<unknown>;

export async function runSealed(
  key: Buffer,
  model: string,
  operation: string,
  args: Plain,
  query: Run,
) {
  const writes = isFullMode();
  const unique = UNIQUE_OPERATIONS.has(operation) || operation === "upsert";
  const prepared = unique
    ? { ...rewriteArgs(key, model, { ...args, where: undefined }) }
    : rewriteArgs(key, model, args);
  if ("data" in args) {
    prepared.data = rewriteData(key, model, args.data, writes);
  }
  if (operation === "upsert") {
    prepared.create = rewriteData(key, model, args.create, writes);
    prepared.update = rewriteData(key, model, args.update, writes);
  }
  if (!unique) return openResult(key, model, await query(prepared));

  const variants = uniqueVariants(key, model, args.where as Plain, writes);
  if (operation === "upsert") {
    const result = await query({ ...prepared, where: variants[0] });
    return openResult(key, model, result);
  }
  for (const [index, where] of variants.entries()) {
    try {
      const row = await query({ ...prepared, where });
      if (row !== null || index === variants.length - 1) {
        return openResult(key, model, row);
      }
    } catch (error) {
      const missing = (error as { code?: string }).code === P2025;
      if (!missing || index === variants.length - 1) throw error;
    }
  }
  return null;
}

export const sealedColumnsExtension = (key: Buffer) =>
  Prisma.defineExtension({
    name: "sealed-columns",
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return runSealed(
            key,
            model,
            operation,
            args as Plain,
            query as Run,
          ) as never;
        },
      },
    },
  });

type Table = {
  findMany: (args: object) => Promise<Record<string, string>[]>;
  updateMany: (args: object) => Promise<{ count: number }>;
};

/**
 * Converts stored rows towards the current mode. Each write is guarded by the
 * value it read, so replicas working at once cannot undo a change.
 */
export async function convertSealedColumns(
  client: PrismaClient,
  key: Buffer,
  logger = new Logger("SealedColumns"),
) {
  const decrypting = isDecryptMode();
  if (!decrypting && !isFullMode()) return;
  let changed = 0;
  for (const [model, columns] of Object.entries(SEALED_COLUMNS)) {
    const table = client[
      (model[0].toLowerCase() + model.slice(1)) as keyof PrismaClient
    ] as unknown as Table;
    const id = PRIMARY_KEYS[model] ?? "id";
    for (const field of Object.keys(columns)) {
      const column = columnOf(model, field) as Column;
      const sealed = { [field]: { startsWith: "enc:" } };
      let cursor = "";
      for (;;) {
        const rows = await table.findMany({
          where: {
            [id]: { gt: cursor },
            ...(decrypting ? sealed : { NOT: sealed }),
          },
          orderBy: { [id]: "asc" },
          select: { [id]: true, [field]: true },
          take: BATCH_SIZE,
        });
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1][id];
        for (const row of rows) {
          const stored = row[field];
          if (stored === null) continue;
          const value = decrypting
            ? open(key, column, stored)
            : seal(key, column, stored);
          if (value === stored) continue;
          const fold =
            column.name === "User.email"
              ? { emailFold: decrypting ? null : emailFold(key, stored) }
              : {};
          try {
            const { count } = await table.updateMany({
              where: { [id]: row[id], [field]: stored },
              data: { [field]: value, ...fold },
            });
            changed += count;
          } catch (error) {
            if ((error as { code?: string }).code !== "P2002") throw error;
            logger.warn(`Skipped a duplicate value of ${column.name}`);
          }
        }
      }
    }
  }
  logger.log(
    `Stored columns ${decrypting ? "decrypted" : "encrypted"} (${changed} values)`,
  );
}
