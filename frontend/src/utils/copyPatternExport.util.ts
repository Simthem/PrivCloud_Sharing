import { isMarkId, markPattern, MARK_TILE } from "./forensicMark.util"

const FORMAT = "privcloud-derived-copy-pattern-v1"
const ROBUST = "privcloud:forensic-multiscale:v2"
const MAX_BYTES = 512 * 1024

/** Explicit per-copy diagnostic only. Never serialize the audit key or identity. */
export async function exportCopyPattern(
  key: Uint8Array,
  markId: string,
  robustMarkAlgorithm?: string,
) {
  if (robustMarkAlgorithm !== undefined && robustMarkAlgorithm !== ROBUST)
    throw new Error("Unsupported copy carrier")
  const pattern = await markPattern(key, markId)
  try {
    const value = JSON.stringify({
      format: FORMAT,
      markId,
      robust: robustMarkAlgorithm === ROBUST,
      pattern: Array.from(pattern),
    })
    if (value.length > MAX_BYTES)
      throw new Error("Copy diagnostic exceeds budget")
    return value
  } finally {
    pattern.fill(0)
  }
}

/** Validate an explicitly supplied diagnostic without accepting any key fields. */
export function parseCopyPattern(value: string) {
  if (typeof value !== "string" || value.length > MAX_BYTES)
    throw new Error("Copy diagnostic exceeds budget")
  const parsed = JSON.parse(value)
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Object.keys(parsed).length !== 4 ||
    parsed.format !== FORMAT ||
    !isMarkId(parsed.markId) ||
    typeof parsed.robust !== "boolean" ||
    !Array.isArray(parsed.pattern) ||
    parsed.pattern.length !== MARK_TILE * MARK_TILE ||
    !parsed.pattern.every(
      (number: unknown) =>
        typeof number === "number" &&
        Number.isFinite(number) &&
        Math.abs(number) <= 1,
    )
  )
    throw new Error("Invalid copy diagnostic")
  if (
    value.trim() !==
    JSON.stringify({
      format: FORMAT,
      markId: parsed.markId,
      robust: parsed.robust,
      pattern: parsed.pattern,
    })
  )
    throw new Error("Noncanonical or ambiguous copy diagnostic")
  return {
    markId: parsed.markId as string,
    robust: parsed.robust as boolean,
    pattern: new Float32Array(parsed.pattern),
  }
}
