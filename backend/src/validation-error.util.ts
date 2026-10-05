import type { ValidationError } from "class-validator";

/** Keep nested constraint paths, never request targets or submitted values. */
export function collectValidationIssues(errors: ValidationError[]) {
  const issues: { property: string; codes: string[]; messages: string[] }[] =
    [];
  const visit = (entries: ValidationError[], parent = "") => {
    for (const error of entries) {
      const property = parent ? `${parent}.${error.property}` : error.property;
      if (error.constraints && Object.keys(error.constraints).length) {
        issues.push({
          property,
          codes: Object.keys(error.constraints),
          messages: Object.values(error.constraints),
        });
      }
      visit(error.children || [], property);
    }
  };
  visit(errors);
  return issues;
}
