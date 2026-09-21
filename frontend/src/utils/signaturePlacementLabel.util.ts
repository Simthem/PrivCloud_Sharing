const normalizeText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export const isSignaturePlacementLabel = (value: string) => {
  const text = normalizeText(value);
  return /(signature|signataire|signer|signed by|customer sign|client sign|bon pour accord|lu et approuve|unterschrift|firma|assinatura|ondertekening|podpis)/i.test(
    text,
  );
};

export const isDatePlacementLabel = (value: string) => {
  const text = normalizeText(value);
  return /(?:^|\b)(date|datum|fecha|data)(?:\b|$)/i.test(text);
};

export const isNamePlacementLabel = (value: string) => {
  const text = normalizeText(value);
  return /(?:^|\b)(nom|name|nombre|nome|cognome|naam)(?:\b|$)/i.test(text);
};

/**
 * How much a text run reads like a field label rather than a passing mention in
 * a sentence. A clause that merely contains the word "signature" must not pull
 * the field into the middle of a paragraph.
 */
export const signatureLabelStrength = (value: string) => {
  const text = normalizeText(value);
  if (!isSignaturePlacementLabel(text)) return 0;
  const words = text.split(" ").filter(Boolean).length;
  if (words > 8) return 0;
  const opensWithLabel =
    /^(signature|signataire|signer|signed by|customer sign|client sign|bon pour accord|lu et approuve|unterschrift|firma|assinatura|ondertekening|podpis)/.test(
      text,
    );
  return Math.max(
    0.15,
    (opensWithLabel ? 1 : 0.6) - Math.max(0, words - 3) * 0.12,
  );
};

/** Wording the issuer leaves on the half of the page they already signed. */
export const isPrefilledSignatureLabel = (value: string) => {
  const text = normalizeText(value);
  return /(lu et approuve|bon pour accord|fait a .+ le |signe le |signed on |gelesen und genehmigt)/i.test(
    text,
  );
};

export type PlacementBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PlacementTextAnchor = PlacementBox & {
  text: string;
};

export const scoreSignatureAnchorContext = (
  anchor: PlacementTextAnchor,
  labels: PlacementTextAnchor[],
) =>
  labels.reduce((score, label) => {
    if (
      !isDatePlacementLabel(label.text) &&
      !isNamePlacementLabel(label.text)
    ) {
      return score;
    }
    const verticalDistance = anchor.top - label.top;
    const horizontallyAligned =
      Math.abs(anchor.left - label.left) <= Math.max(120, anchor.width * 2);
    return verticalDistance >= -20 &&
      verticalDistance <= 140 &&
      horizontallyAligned
      ? score + 1
      : score;
  }, 0);

export const placeSignatureBesideTextAnchor = <
  T extends {
    left: number;
    top: number;
    width: number;
  },
>(
  anchor: T,
) => ({
  ...anchor,
  left: anchor.left + anchor.width + 8,
  top: anchor.top,
});
