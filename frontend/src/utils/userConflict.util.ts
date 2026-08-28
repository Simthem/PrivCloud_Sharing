type ConflictField = "email" | "username" | "email or username";

/** Reads the stable API error code without trusting connector-specific text. */
export function getUserUniqueConflictField(error: unknown): ConflictField | null {
  if (!isRecord(error) || !isRecord(error.response)) return null;
  if (error.response.status !== 400 || !isRecord(error.response.data)) return null;
  if (error.response.data.code !== "user_unique_conflict") return null;

  const field = error.response.data.field;
  return field === "email" || field === "username" || field === "email or username"
    ? field
    : "email or username";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

