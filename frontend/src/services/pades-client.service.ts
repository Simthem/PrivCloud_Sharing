import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFInvalidObject,
  PDFName,
  PDFNumber,
  PDFString,
} from "pdf-lib";

const BYTE_RANGE_PLACEHOLDER = "**********";
const SIGNATURE_HEX_LENGTH = 32768;
const SIGNATURES_EXIST = 1;
const APPEND_ONLY = 2;
const ANNOTATION_PRINT = 4;

type PreparedPadesPdf = {
  bytes: Uint8Array;
  digest: string;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

const asciiBytes = (value: string): Uint8Array => {
  const result = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) result[i] = value.charCodeAt(i);
  return result;
};

const findAscii = (bytes: Uint8Array, value: string): number => {
  const needle = asciiBytes(value);
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
};

const findSignatureSlot = (bytes: Uint8Array) => {
  for (let open = 0; open < bytes.length - 1002; open++) {
    if (bytes[open] !== 0x3c || bytes[open + 1] !== 0x00) continue;

    let close = open + 1;
    while (close < bytes.length && bytes[close] === 0x00) close++;
    if (close - open - 1 >= 1000 && bytes[close] === 0x3e) {
      return { open, close, length: close - open - 1 };
    }
  }
  throw new Error("Emplacement de signature PAdES introuvable dans le PDF");
};

const addSignaturePlaceholder = (pdfDoc: PDFDocument) => {
  const page = pdfDoc.getPages()[0];
  if (!page) throw new Error("Le PDF ne contient aucune page");

  const byteRange = PDFArray.withContext(pdfDoc.context);
  byteRange.push(PDFNumber.of(0));
  byteRange.push(PDFName.of(BYTE_RANGE_PLACEHOLDER));
  byteRange.push(PDFName.of(BYTE_RANGE_PLACEHOLDER));
  byteRange.push(PDFName.of(BYTE_RANGE_PLACEHOLDER));

  const signatureDict = pdfDoc.context.obj({
    Type: "Sig",
    Filter: "Adobe.PPKLite",
    SubFilter: "ETSI.CAdES.detached",
    ByteRange: byteRange,
    Contents: PDFHexString.of(
      String.fromCharCode(0).repeat(SIGNATURE_HEX_LENGTH),
    ),
    Reason: PDFString.of(
      "Signature électronique eIDAS (E2E) - Tous les signataires ont signé",
    ),
    M: PDFString.fromDate(new Date()),
    ContactInfo: PDFString.of("PrivCloud Sharing"),
    Name: PDFString.of("PrivCloud Sharing"),
    Location: PDFString.of("PrivCloud Sharing Platform"),
    Prop_Build: {
      Filter: { Name: "Adobe.PPKLite" },
      App: { Name: "PrivCloud Sharing" },
    },
  });
  const signatureBuffer = new Uint8Array(signatureDict.sizeInBytes());
  signatureDict.copyBytesInto(signatureBuffer, 0);
  const signatureRef = pdfDoc.context.register(
    PDFInvalidObject.of(signatureBuffer),
  );

  const rect = pdfDoc.context.obj([0, 0, 0, 0]) as PDFArray;
  const appearance = pdfDoc.context.formXObject([], {
    BBox: [0, 0, 0, 0],
    Resources: {},
  });
  const widget = pdfDoc.context.obj({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    Rect: rect,
    V: signatureRef,
    T: PDFString.of("Signature1"),
    F: ANNOTATION_PRINT,
    P: page.ref,
    AP: { N: pdfDoc.context.register(appearance) },
  });
  const widgetRef = pdfDoc.context.register(widget);

  let annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annotations) annotations = pdfDoc.context.obj([]) as PDFArray;
  annotations.push(widgetRef);
  page.node.set(PDFName.of("Annots"), annotations);

  let acroForm = pdfDoc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  if (!acroForm) {
    acroForm = pdfDoc.context.obj({ Fields: [] }) as PDFDict;
    pdfDoc.catalog.set(
      PDFName.of("AcroForm"),
      pdfDoc.context.register(acroForm),
    );
  }

  const currentFlags =
    acroForm.lookupMaybe(PDFName.of("SigFlags"), PDFNumber)?.asNumber() || 0;
  acroForm.set(
    PDFName.of("SigFlags"),
    PDFNumber.of(currentFlags | SIGNATURES_EXIST | APPEND_ONLY),
  );

  let fields = acroForm.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if (!fields) {
    fields = pdfDoc.context.obj([]) as PDFArray;
    acroForm.set(PDFName.of("Fields"), fields);
  }
  fields.push(widgetRef);
};

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

export const preparePadesPdf = async (
  visualPdf: Uint8Array,
  certificatePage: Uint8Array,
): Promise<PreparedPadesPdf> => {
  const pdfDoc = await PDFDocument.load(visualPdf);
  const certDoc = await PDFDocument.load(certificatePage);
  const [certPageCopy] = await pdfDoc.copyPages(certDoc, [0]);
  pdfDoc.addPage(certPageCopy);
  pdfDoc.setProducer("PrivCloud Sharing - Signature électronique PDF PAdES");
  pdfDoc.setCreator("PrivCloud Sharing");
  addSignaturePlaceholder(pdfDoc);

  const bytes = new Uint8Array(await pdfDoc.save({ useObjectStreams: false }));
  const slot = findSignatureSlot(bytes);
  const byteRangeStart = findAscii(bytes, "/ByteRange [");
  if (byteRangeStart < 0)
    throw new Error("ByteRange PAdES introuvable dans le PDF");

  let byteRangeEnd = byteRangeStart;
  while (byteRangeEnd < bytes.length && bytes[byteRangeEnd] !== 0x5d)
    byteRangeEnd++;
  if (byteRangeEnd >= bytes.length) throw new Error("ByteRange PAdES invalide");

  const prefixLength = "/ByteRange [".length;
  const innerLength = byteRangeEnd - byteRangeStart - prefixLength;
  const afterSlot = slot.close + 1;
  const byteRange = [0, slot.open, afterSlot, bytes.length - afterSlot];
  const values = byteRange.join(" ");
  if (values.length > innerLength)
    throw new Error("Le ByteRange PAdES dépasse son emplacement");

  const replacement = asciiBytes(
    `/ByteRange [${values.padEnd(innerLength, " ")}]`,
  );
  bytes.set(replacement, byteRangeStart);

  const signedBytes = new Uint8Array(slot.open + bytes.length - afterSlot);
  signedBytes.set(bytes.subarray(0, slot.open), 0);
  signedBytes.set(bytes.subarray(afterSlot), slot.open);

  return { bytes, digest: await sha256Hex(signedBytes) };
};

export const embedPadesCms = (
  preparedPdf: Uint8Array,
  cms: Uint8Array,
): Uint8Array => {
  const bytes = new Uint8Array(preparedPdf);
  const slot = findSignatureSlot(bytes);
  if (cms.length * 2 > slot.length) {
    throw new Error(
      `La signature CMS (${cms.length} octets) dépasse l’emplacement PDF (${slot.length / 2} octets)`,
    );
  }

  const hex = Array.from(cms, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  bytes.fill(0x30, slot.open + 1, slot.close);
  bytes.set(asciiBytes(hex), slot.open + 1);
  return bytes;
};
