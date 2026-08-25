export const PROBE_MAX_BODY_BYTES = 8_000_000;

export type HttpRequestLike = {
  method?: string;
  originalUrl?: string;
  url?: string;
};

export type ProbeValidationResult =
  | { ok: true; length: number }
  | { ok: false; statusCode: 400 | 411 | 413 | 415; message: string };

export function isProbeRequest(request: HttpRequestLike): boolean {
  const requestPath = (request.originalUrl ?? request.url ?? "").split(
    "?",
    1,
  )[0];
  return request.method === "POST" && requestPath === "/api/probe";
}

export function validateProbeContentLength(
  contentLength: string | string[] | undefined,
): ProbeValidationResult {
  if (contentLength === undefined) {
    return {
      ok: false,
      statusCode: 411,
      message: "Content-Length is required for bandwidth probes",
    };
  }
  if (Array.isArray(contentLength) || !/^\d+$/.test(contentLength)) {
    return {
      ok: false,
      statusCode: 400,
      message: "Invalid Content-Length for bandwidth probe",
    };
  }

  const parsed = Number(contentLength);
  if (!Number.isSafeInteger(parsed)) {
    return {
      ok: false,
      statusCode: 400,
      message: "Invalid Content-Length for bandwidth probe",
    };
  }
  if (parsed > PROBE_MAX_BODY_BYTES) {
    return {
      ok: false,
      statusCode: 413,
      message: `Bandwidth probe exceeds ${PROBE_MAX_BODY_BYTES} bytes`,
    };
  }

  return { ok: true, length: parsed };
}

export function validateProbeBody(
  body: unknown,
  declaredLength: number,
  contentType: string | undefined,
): ProbeValidationResult {
  if (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/octet-stream"
  ) {
    return {
      ok: false,
      statusCode: 415,
      message: "Bandwidth probes require application/octet-stream",
    };
  }
  if (!Buffer.isBuffer(body) || body.length !== declaredLength) {
    return {
      ok: false,
      statusCode: 400,
      message: "Bandwidth probe body does not match Content-Length",
    };
  }
  if (body.length > PROBE_MAX_BODY_BYTES) {
    return {
      ok: false,
      statusCode: 413,
      message: `Bandwidth probe exceeds ${PROBE_MAX_BODY_BYTES} bytes`,
    };
  }

  return { ok: true, length: body.length };
}
