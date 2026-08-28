const MAX_API_PATH_SEGMENT_LENGTH = 4_096;

/**
 * Encode one untrusted value as exactly one URL path segment.
 *
 * encodeURIComponent intentionally leaves dots untouched. Encoding them too
 * prevents `.` and `..` from being interpreted as URL path traversal segments
 * after the value is interpolated into a relative Axios/fetch URL.
 */
export function apiPathSegment(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_API_PATH_SEGMENT_LENGTH
  ) {
    throw new TypeError("Invalid API path segment");
  }

  try {
    return encodeURIComponent(value).replaceAll(".", "%2E");
  } catch {
    throw new TypeError("Invalid API path segment");
  }
}
