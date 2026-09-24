import { BadRequestException, ForbiddenException } from "@nestjs/common";

export type FillableSignatureField = {
  id: string;
  type: string;
  label: string | null;
  required: boolean;
  assignedRecipientId: string | null;
};

export function normalizeSignatureText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr-FR");
}

/**
 * Resolves the exact field values persisted for a recipient. The WebAuthn
 * manifest is built from this same output so the signer commits to what the
 * final PDF will show, including server defaults such as the date.
 */
export function collectRecipientFieldValues(
  recipientId: string,
  fields: FillableSignatureField[],
  submittedValues: Array<{ fieldId: string; value: string }>,
) {
  const fillableFields = fields.filter(
    (field) =>
      !field.assignedRecipientId || field.assignedRecipientId === recipientId,
  );
  const fillableFieldIds = new Set(fillableFields.map((field) => field.id));
  const submittedByField = new Map(
    submittedValues.map((entry) => [entry.fieldId, entry.value.trim()]),
  );

  for (const submitted of submittedValues) {
    if (!fillableFieldIds.has(submitted.fieldId)) {
      throw new ForbiddenException(
        "Cannot fill a field assigned to another signer",
      );
    }
  }

  const rows: Array<{ fieldId: string; recipientId: string; value: string }> =
    [];
  for (const field of fillableFields) {
    if (field.type === "SIGNATURE" || field.type === "INITIALS") continue;

    let value = submittedByField.get(field.id) || "";
    if (field.type === "DATE" && !value) {
      value = new Date().toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Europe/Paris",
      });
    }

    if (field.required && !value) {
      throw new BadRequestException("A required signature field is missing");
    }

    if (
      field.type === "APPROVAL" &&
      field.label?.trim() &&
      normalizeSignatureText(value) !== normalizeSignatureText(field.label)
    ) {
      throw new BadRequestException(
        "The approval mention does not match the expected text",
      );
    }

    if (value) rows.push({ fieldId: field.id, recipientId, value });
  }

  return rows;
}
