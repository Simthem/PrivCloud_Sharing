import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from "@nestjs/common";

/**
 * Validates that a route parameter is a safe identifier -- no path traversal
 * sequences, no directory separators, no null bytes.
 *
 * CWE-23 mitigation: even though guards verify DB existence before the ID
 * reaches filesystem operations, this pipe acts as defense-in-depth to block
 * malicious path fragments at the controller boundary.
 */
@Injectable()
export class SafeIdPipe implements PipeTransform<string, string> {
  private static readonly ALLOWED = /^[A-Za-z0-9_-]{1,255}$/u;

  transform(value: string, _metadata: ArgumentMetadata): string {
    if (typeof value !== "string" || !SafeIdPipe.ALLOWED.test(value)) {
      throw new BadRequestException("Invalid identifier");
    }
    return value;
  }
}
