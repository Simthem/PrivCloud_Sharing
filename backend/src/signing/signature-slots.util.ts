/**
 * Shared layout of the visual signature blocks, so that several signers never
 * land on top of each other. The same file exists in the frontend, where the
 * E2E finalization and the request editor use it.
 */

export type SlotRect = { x: number; y: number; width: number; height: number };

export type SignatureFieldBox = {
  page: number;
  posX: number;
  posY: number;
  width: number;
  height: number;
};

export type SignatureSlot =
  | { kind: "field"; field: SignatureFieldBox }
  | { kind: "default"; index: number; count: number };

/**
 * Smallest block that still holds the "Lu et approuvé" mention, the name and a
 * legible signature image without clipping.
 */
export const MIN_SIGNATURE_SLOT_POINTS = { width: 170, height: 90 };
export const SIGNATURE_SLOT_GAP_POINTS = 8;

/**
 * Splits one area between `count` signers: side by side when each column stays
 * wide enough, stacked when each row stays tall enough, otherwise a grid of
 * minimum-size blocks growing away from the area's top edge.
 * `yAxis: "up"` is for PDF coordinates, `"down"` for top-left page coordinates.
 */
export function splitSignatureArea(
  area: SlotRect,
  count: number,
  options: {
    minWidth: number;
    minHeight: number;
    gap: number;
    yAxis: "up" | "down";
  },
): SlotRect[] {
  if (count <= 1) return [area];
  const { minWidth, minHeight, gap, yAxis } = options;
  const rowY = (row: number, height: number) =>
    yAxis === "down"
      ? area.y + row * (height + gap)
      : area.y + area.height - (row + 1) * height - row * gap;

  const columnWidth = (area.width - gap * (count - 1)) / count;
  if (columnWidth >= minWidth) {
    return Array.from({ length: count }, (_, index) => ({
      x: area.x + index * (columnWidth + gap),
      y: area.y,
      width: columnWidth,
      height: area.height,
    }));
  }

  const rowHeight = (area.height - gap * (count - 1)) / count;
  if (rowHeight >= minHeight) {
    return Array.from({ length: count }, (_, index) => ({
      x: area.x,
      y: rowY(index, rowHeight),
      width: area.width,
      height: rowHeight,
    }));
  }

  const columns = Math.max(
    1,
    Math.min(count, Math.floor((area.width + gap) / (minWidth + gap))),
  );
  const width =
    columns === 1
      ? Math.max(area.width, minWidth)
      : (area.width - gap * (columns - 1)) / columns;
  const height = minHeight;
  const grid = Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      x: area.x + column * (width + gap),
      y: rowY(row, height),
      width,
      height,
    };
  });
  // In PDF coordinates the grid grows towards the bottom edge of the page.
  // Lift it as a whole rather than letting the renderer pile the last rows up.
  const lift =
    yAxis === "up" ? Math.max(0, ...grid.map((rect) => -rect.y)) : 0;
  return grid.map((rect) => ({ ...rect, y: rect.y + lift }));
}

/**
 * Gives every signer its own block. A field assigned to the signer wins. Signers
 * without one share the unassigned signature fields, each shared field being
 * split between the signers it receives. Without any such field, signers get
 * consecutive positions of the default grid.
 */
export function resolveSignatureSlots(
  recipientIds: string[],
  fields: Array<
    SignatureFieldBox & { type: string; assignedRecipientId: string | null }
  >,
): Map<string, SignatureSlot> {
  const signatureFields = fields.filter((field) => field.type === "SIGNATURE");
  const slots = new Map<string, SignatureSlot>();
  const unplaced: string[] = [];
  for (const recipientId of recipientIds) {
    const assigned = signatureFields.find(
      (field) => field.assignedRecipientId === recipientId,
    );
    if (assigned) slots.set(recipientId, { kind: "field", field: assigned });
    else unplaced.push(recipientId);
  }

  const shared = signatureFields.filter((field) => !field.assignedRecipientId);
  if (shared.length === 0) {
    unplaced.forEach((recipientId, index) =>
      slots.set(recipientId, {
        kind: "default",
        index,
        count: unplaced.length,
      }),
    );
    return slots;
  }

  shared.forEach((field, fieldIndex) => {
    const group = unplaced.filter(
      (_, index) => index % shared.length === fieldIndex,
    );
    const areas = splitSignatureArea(
      { x: field.posX, y: field.posY, width: field.width, height: field.height },
      group.length,
      {
        minWidth: MIN_SIGNATURE_SLOT_POINTS.width,
        minHeight: MIN_SIGNATURE_SLOT_POINTS.height,
        gap: SIGNATURE_SLOT_GAP_POINTS,
        yAxis: "up",
      },
    );
    group.forEach((recipientId, index) =>
      slots.set(recipientId, {
        kind: "field",
        field: {
          page: field.page,
          posX: areas[index].x,
          posY: areas[index].y,
          width: areas[index].width,
          height: areas[index].height,
        },
      }),
    );
  });
  return slots;
}

/**
 * Position of one block of the default grid, in visual page points with a
 * bottom-left origin. Blocks read left to right then top to bottom, and the
 * grid is right-aligned on `rightEdge` with its lowest row at `baseY`, so a
 * single signer keeps the historical position.
 */
export function defaultSignatureSlotPosition(input: {
  index: number;
  count: number;
  pageWidth: number;
  boxWidth: number;
  boxHeight: number;
  rightEdge: number;
  baseY: number;
}): { x: number; y: number } {
  const gap = SIGNATURE_SLOT_GAP_POINTS;
  const available = input.rightEdge - (input.pageWidth - input.rightEdge);
  const columns = Math.max(
    1,
    Math.min(input.count, Math.floor((available + gap) / (input.boxWidth + gap))),
  );
  const rows = Math.ceil(input.count / columns);
  const column = input.index % columns;
  const row = Math.floor(input.index / columns);
  return {
    x:
      input.rightEdge -
      columns * input.boxWidth -
      (columns - 1) * gap +
      column * (input.boxWidth + gap),
    y: input.baseY + (rows - 1 - row) * (input.boxHeight + gap),
  };
}

/** Largest size of the signature image that fits the block without distortion. */
export function fitSignatureImage(
  natural: { width: number; height: number },
  max: { width: number; height: number },
): { width: number; height: number } {
  if (natural.width <= 0 || natural.height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(
    1,
    max.width / natural.width,
    max.height / natural.height,
  );
  return { width: natural.width * scale, height: natural.height * scale };
}
