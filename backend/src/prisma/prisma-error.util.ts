/**
 * Prisma's P2002 metadata is connector-dependent. PostgreSQL commonly returns
 * an array in meta.target, while driver adapters (notably SQLite) may omit it
 * or expose only a constraint name. Error handling must never assume either
 * shape: a duplicate registration is a client conflict, not a 500.
 *
 * Only public user fields are returned. Unknown constraint/driver details stay
 * behind a generic label instead of leaking schema identifiers to the client.
 */
export function describeUserUniqueConflict(
  error: unknown,
): "email" | "username" | "email or username" {
  if (!isRecord(error) || !isRecord(error.meta)) {
    return "email or username";
  }

  const driverAdapterError = isRecord(error.meta.driverAdapterError)
    ? error.meta.driverAdapterError
    : null;
  const driverCause =
    driverAdapterError && isRecord(driverAdapterError.cause)
      ? driverAdapterError.cause
      : null;
  const driverConstraint =
    driverCause && isRecord(driverCause.constraint)
      ? driverCause.constraint
      : null;

  const candidates = [
    ...stringsFrom(error.meta.target),
    ...stringsFrom(error.meta.constraint),
    ...stringsFrom(error.meta.fields),
    ...stringsFrom(error.meta.field_name),
    ...stringsFrom(driverConstraint?.fields),
  ];

  for (const field of ["email", "username"] as const) {
    if (
      candidates.some((candidate) =>
        candidate
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .includes(field),
      )
    ) {
      return field;
    }
  }

  return "email or username";
}

export function createUserUniqueConflictResponse(error: unknown): {
  code: "user_unique_conflict";
  field: "email" | "username" | "email or username";
  message: string;
} {
  const field = describeUserUniqueConflict(error);
  return {
    code: "user_unique_conflict",
    field,
    message: `A user with this ${field} already exists`,
  };
}

function stringsFrom(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
