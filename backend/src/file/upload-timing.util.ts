import type { Request } from "express";
import type { Readable } from "stream";

const UPLOAD_REQUEST_STARTED_AT = Symbol("privcloud.uploadRequestStartedAt");

type TimedUploadStream = Readable & {
  [UPLOAD_REQUEST_STARTED_AT]?: number;
};

/**
 * Record server-side request arrival before parsers, guards and controllers.
 *
 * A non-enumerable symbol keeps the diagnostic internal and prevents it from
 * leaking through request serialization or application responses.
 */
export function markUploadRequestStarted(req: Request): void {
  Object.defineProperty(req, UPLOAD_REQUEST_STARTED_AT, {
    configurable: false,
    enumerable: false,
    value: Date.now(),
    writable: false,
  });
}

export function getUploadRequestStartedAt(
  stream: Readable,
): number | undefined {
  return (stream as TimedUploadStream)[UPLOAD_REQUEST_STARTED_AT];
}
