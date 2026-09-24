import { DOMParser } from "@xmldom/xmldom";
import * as crypto from "crypto";
import { SignedXml } from "xml-crypto";

/**
 * Minimal reading of an ETSI TS 119 612 Trusted List: enough to tell whether
 * a pinned TSA certificate authority is still a granted qualified time stamp
 * service. Lists are only read from the content their enveloped XML
 * signature covers.
 */

export type TrustedListService = {
  name: string;
  type: string | null;
  status: string | null;
  statusStartingTime: Date | null;
  certificateSha256: string[];
};

export type TrustedList = {
  territory: string | null;
  sequenceNumber: string | null;
  issuedAt: Date | null;
  nextUpdate: Date | null;
  services: TrustedListService[];
};

const QTST = "http://uri.etsi.org/TrstSvc/Svctype/TSA/QTST";
const GRANTED = "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted";

const elements = (xml: string, name: string) =>
  [
    ...xml.matchAll(
      new RegExp(
        `<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`,
        "g",
      ),
    ),
  ].map((match) => match[1]);

const firstText = (xml: string, name: string) =>
  elements(xml, name)[0]?.trim() || null;

const dateOrNull = (value: string | null) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

export function parseTrustedList(xml: string): TrustedList {
  return {
    territory: firstText(xml, "SchemeTerritory"),
    sequenceNumber: firstText(xml, "TSLSequenceNumber"),
    issuedAt: dateOrNull(firstText(xml, "ListIssueDateTime")),
    nextUpdate: dateOrNull(firstText(firstText(xml, "NextUpdate") || "", "dateTime")),
    services: elements(xml, "TSPService").map((service) => {
      const information = firstText(service, "ServiceInformation") || "";
      return {
        name: (firstText(firstText(information, "ServiceName") || "", "Name") || "unnamed")
          .replace(/\s+/g, " "),
        type: firstText(information, "ServiceTypeIdentifier"),
        status: firstText(information, "ServiceStatus"),
        statusStartingTime: dateOrNull(firstText(information, "StatusStartingTime")),
        certificateSha256: elements(information, "X509Certificate")
          .map((base64) => Buffer.from(base64.replace(/\s/g, ""), "base64"))
          .filter((der) => der.length > 0)
          .map((der) => crypto.createHash("sha256").update(der).digest("hex")),
      };
    }),
  };
}

export type PinnedTsaEvaluation = {
  result: "OK" | "ALERT";
  lines: string[];
};

/**
 * Every pinned certificate must belong to a service that is currently a
 * granted qualified time stamp service, and the list must not be past its
 * announced next update.
 */
export function evaluatePinnedTsa(
  list: TrustedList,
  pinnedSha256: string[],
  now = new Date(),
): PinnedTsaEvaluation {
  const lines: string[] = [];
  let ok = pinnedSha256.length > 0;
  if (pinnedSha256.length === 0) {
    lines.push("No TSA certificate is pinned (SIGNING_TSA_TRUSTED_CERT_SHA256).");
  }
  if (list.nextUpdate && list.nextUpdate < now) {
    ok = false;
    lines.push(
      `The list is past its announced next update (${list.nextUpdate.toISOString()}).`,
    );
  }
  for (const fingerprint of pinnedSha256) {
    const services = list.services.filter((service) =>
      service.certificateSha256.includes(fingerprint),
    );
    if (services.length === 0) {
      ok = false;
      lines.push(`${fingerprint}: NOT LISTED in the Trusted List.`);
      continue;
    }
    for (const service of services) {
      const granted = service.type === QTST && service.status === GRANTED;
      if (!granted) ok = false;
      lines.push(
        `${fingerprint}: ${granted ? "GRANTED" : "NOT GRANTED"}, ` +
          `${service.name}, type ${service.type?.split("/").pop() || "unknown"}, ` +
          `status ${service.status?.split("/").pop() || "unknown"}` +
          (service.statusStartingTime
            ? ` since ${service.statusStartingTime.toISOString()}`
            : ""),
      );
    }
  }
  return { result: ok ? "OK" : "ALERT", lines };
}

const XMLDSIG = "http://www.w3.org/2000/09/xmldsig#";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

const sha256Of = (der: Buffer) =>
  crypto.createHash("sha256").update(der).digest("hex");

export type SignedTrustedList = {
  /** Canonical content covered by the signature, the only part to read. */
  signedXml: string;
  signer: crypto.X509Certificate;
  signerSha256: string;
};

/**
 * Checks the enveloped XAdES signature of a Trusted List (or of the EU List
 * of Trusted Lists) with the certificate it carries, and returns the signed
 * content. Whether that certificate may sign the list is decided by the
 * pointer of the EU List of Trusted Lists, see {@link listSignerIsAuthorized}.
 */
export function verifyTrustedListSignature(xml: string): SignedTrustedList {
  const root = new DOMParser().parseFromString(xml, "text/xml").documentElement;
  const signatures = Array.from(root?.childNodes || []).filter(
    (node) =>
      node.nodeType === 1 &&
      (node as Element).localName === "Signature" &&
      (node as Element).namespaceURI === XMLDSIG,
  ) as Element[];
  if (signatures.length !== 1) {
    throw new Error("The list does not carry exactly one enveloped signature");
  }
  const certificate = signatures[0]
    .getElementsByTagNameNS(XMLDSIG, "X509Certificate")[0]
    ?.textContent?.replace(/\s/g, "");
  if (!certificate) throw new Error("The list signature carries no certificate");
  const signer = new crypto.X509Certificate(Buffer.from(certificate, "base64"));
  const signature = new SignedXml({
    publicCert: signer.toString(),
    getCertFromKeyInfo: () => null,
  });
  signature.loadSignature(signatures[0]);
  let valid = false;
  try {
    valid = signature.checkSignature(xml);
  } catch {
    valid = false;
  }
  if (!valid) throw new Error("The XML signature of the list is invalid");
  const whole = signature
    .getReferences()
    .find(
      (reference) =>
        reference.uri === "" && reference.transforms.includes(ENVELOPED),
    );
  if (!whole?.signedReference) {
    throw new Error("The list signature does not cover the whole list");
  }
  return {
    signedXml: whole.signedReference,
    signer,
    signerSha256: sha256Of(signer.raw),
  };
}

export type TrustedListPointer = {
  territory: string | null;
  location: string | null;
  certificateSha256: string[];
};

/** Pointers of the EU List of Trusted Lists to the national lists. */
export function parseListPointers(signedLotlXml: string): TrustedListPointer[] {
  return elements(signedLotlXml, "OtherTSLPointer").map((pointer) => ({
    territory: firstText(pointer, "SchemeTerritory"),
    location: firstText(pointer, "TSLLocation"),
    certificateSha256: elements(pointer, "X509Certificate")
      .map((base64) => Buffer.from(base64.replace(/\s/g, ""), "base64"))
      .filter((der) => der.length > 0)
      .map(sha256Of),
  }));
}

/**
 * A list may only be signed by a certificate that the EU List of Trusted
 * Lists gives for its territory.
 */
export const listSignerIsAuthorized = (
  pointers: TrustedListPointer[],
  territory: string | null,
  signerSha256: string,
) =>
  pointers.some(
    (pointer) =>
      pointer.territory === territory &&
      pointer.certificateSha256.includes(signerSha256),
  );

/** Official Journal publications of the certificates allowed to sign the LOTL. */
export const officialJournalReferences = (signedLotlXml: string) => [
  ...new Set(signedLotlXml.match(/https?:\/\/eur-lex\.europa\.eu\/[^<\s"]+/g) || []),
];
